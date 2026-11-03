import "server-only";
import { and, eq, gte, inArray, isNull, lte, desc } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, statusAfterTransferReversal, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday } from "@/domain/business-days";
import { normalizeBlNumber } from "@/domain/bl-number";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { unitChoiceError } from "./agencies";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { auditLog, billsOfLading, customers, ledgerEntries, requests, users } from "./db/schema";
import { lockForDraft, releaseDraftLocks } from "./draft-locks";
import { DomainError } from "./errors";
import { activeLedgerEntries, addLedgerEntry, compensateLedgerEntry, hasConfirmedAllocation } from "./ledger";
import { joinableBl } from "./payments";

type Bl = typeof billsOfLading.$inferSelect;

export type TransferInput = {
  sourceBlId: number;
  /** A new B/L number, or the number of an open B/L of the same agency and currency. */
  targetBlNo: string;
  /** When the agency moved the deposit; the new B/L's request clock starts here. */
  transferredOn: string;
  /** For a new B/L only: prefilled from the source in the dialog. */
  customerId: number | null;
  fileNo: string | null;
  unitId: number | null;
  note: string | null;
};

const TRANSFERABLE: readonly StoredBlStatus[] = ["PAID", "REQUESTED", "AWAITING_RETURN"];

function requireBl(tx: DbOrTx, id: number): Bl {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get();
  if (!bl) throw new DomainError("errors.notFound");
  return bl;
}

const ledgerOf = (tx: DbOrTx, blId: number) => tx.select().from(ledgerEntries).where(eq(ledgerEntries.blId, blId)).all();

/** What the source B/L can transfer: its whole outstanding deposit, while it is open and nothing was refunded yet. */
function transferable(tx: DbOrTx, source: Bl): number {
  if (source.voidedAt) throw new DomainError("bls.errors.voided");
  if (!TRANSFERABLE.includes(source.status as StoredBlStatus)) throw new DomainError("transfers.errors.notOpen", { bl: source.blNo });
  if (hasConfirmedAllocation(tx, source.id)) throw new DomainError("transfers.errors.allocated", { bl: source.blNo });
  const amount = blBalance(ledgerOf(tx, source.id), source.currency).expectedMinor;
  if (amount <= 0) throw new DomainError("transfers.errors.nothing", { bl: source.blNo });
  return amount;
}

export type TransferPreview = {
  amountMinor: number;
  currency: string;
  /** The open B/L the deposit would join; null when the number is free (a new B/L). */
  existing: { blId: number; blNo: string; depositMinor: number } | null;
};

/** What a transfer to this number would do, shown in the dialog before saving. */
export function previewTransfer(db: DbOrTx, actor: AuthUser, input: { sourceBlId: number; targetBlNo: string }): TransferPreview {
  authorize(actor, "bl.transferDeposit");
  const source = requireBl(db, input.sourceBlId);
  const amountMinor = transferable(db, source);
  return { amountMinor, currency: source.currency, existing: target(db, source, input.targetBlNo) };
}

/** The open B/L a transfer joins, or null for a new B/L; refuses one it cannot join. */
function target(tx: DbOrTx, source: Bl, blNo: string) {
  const found = joinableBl(tx, blNo, source);
  if (!found) return null;
  if (found.bl.id === source.id) throw new DomainError("transfers.errors.same");
  if (found.problem === "closed") throw new DomainError("payments.errors.additionalClosed", { bl: found.bl.blNo });
  if (found.problem) throw new DomainError("payments.errors.additionalMismatch", { bl: found.bl.blNo });
  const deposit = blBalance(ledgerOf(tx, found.bl.id), found.bl.currency).depositMinor;
  return { blId: found.bl.id, blNo: found.bl.blNo, depositMinor: deposit };
}

const appended = (description: string | null, line: string) => (description ? `${description}\n${line}` : line);

/**
 * Moves a B/L's whole outstanding deposit to another B/L, when the agency applied it there
 * instead of refunding it (accounting or operations). The source settles and waits for the
 * accounting entry (then TRANSFERRED); the target is a new B/L that starts like any other,
 * its request clock from the transfer date, or an open B/L the deposit joins. No money leaves
 * or arrives: a TRANSFER_OUT on the source and a TRANSFER_IN of the same amount on the target.
 * Requests of the target attach the source's receipt, under the source's name.
 */
export function transferDeposit(db: Db, actor: AuthUser, input: TransferInput, now: Date = new Date()): { targetBlId: number; created: boolean } {
  const roleUsed = authorize(actor, "bl.transferDeposit");
  return db.transaction((tx) => {
    const source = requireBl(tx, input.sourceBlId);
    const amountMinor = transferable(tx, source);
    if (input.transferredOn > istanbulToday(now)) throw new DomainError("payments.errors.futureDate");
    if (input.transferredOn < source.paidAt) throw new DomainError("transfers.errors.beforePayment");
    // Not while someone drafts a request for it (rule 14).
    lockForDraft(tx, actor, [source.id], now);
    releaseDraftLocks(tx, actor, [source.id]);

    const at = now.toISOString();
    const money = formatMoney(amountMinor, source.currency);
    const date = formatBusinessDate(input.transferredOn);
    const existing = target(tx, source, input.targetBlNo);
    let targetBl: Bl;
    if (existing) {
      if (input.customerId !== null || input.fileNo || input.unitId !== null) throw new DomainError("transfers.errors.joinFields", { bl: existing.blNo });
      targetBl = requireBl(tx, existing.blId);
    } else {
      if (input.customerId !== null && !tx.select({ active: customers.active }).from(customers).where(eq(customers.id, input.customerId)).get()?.active) {
        throw new DomainError("customers.errors.unknown");
      }
      const unitError = unitChoiceError(tx, source.agencyId, input.unitId);
      if (unitError) throw new DomainError(unitError);
      targetBl = tx
        .insert(billsOfLading)
        .values({
          blNo: normalizeBlNumber(input.targetBlNo),
          depositPaymentId: null,
          agencyId: source.agencyId,
          currency: source.currency,
          depositAmountMinor: amountMinor,
          // The request clock of the new B/L starts at the transfer.
          paidAt: input.transferredOn,
          status: "PAID",
          customerId: input.customerId,
          fileNo: input.fileNo,
          unitId: input.unitId,
          createdBy: actor.id,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
    }

    addLedgerEntry(tx, { blId: source.id, type: "TRANSFER_OUT", amountMinor, currency: source.currency, entryDate: input.transferredOn, transferBlId: targetBl.id, createdBy: actor.id }, now);
    addLedgerEntry(tx, { blId: targetBl.id, type: "TRANSFER_IN", amountMinor, currency: source.currency, entryDate: input.transferredOn, transferBlId: source.id, createdBy: actor.id }, now);

    const sourceStatus = nextStatus(source.status as StoredBlStatus, "DEPOSIT_TRANSFERRED");
    const outLine = t("transfers.descriptionOut", { amount: money, bl: targetBl.blNo, date });
    const inLine = t("transfers.descriptionIn", { amount: money, bl: source.blNo, date });
    tx.update(billsOfLading)
      .set({ status: sourceStatus, description: appended(source.description, outLine), updatedAt: at })
      .where(eq(billsOfLading.id, source.id))
      .run();
    const deposit = blBalance(ledgerOf(tx, targetBl.id), targetBl.currency).depositMinor;
    tx.update(billsOfLading)
      .set({ depositAmountMinor: deposit, description: appended(targetBl.description, inLine), updatedAt: at })
      .where(eq(billsOfLading.id, targetBl.id))
      .run();

    const detail = { amountMinor, currency: source.currency, transferredOn: input.transferredOn };
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.transferOut",
        entityType: "bill_of_lading",
        entityId: source.id,
        before: { status: source.status },
        after: { ...detail, status: sourceStatus, targetBlId: targetBl.id, targetBlNo: targetBl.blNo, created: !existing },
        reason: input.note,
      },
      now,
    );
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: existing ? "bl.transferIn" : "bl.createFromTransfer",
        entityType: "bill_of_lading",
        entityId: targetBl.id,
        before: existing ? { depositAmountMinor: targetBl.depositAmountMinor } : null,
        after: { ...detail, sourceBlId: source.id, sourceBlNo: source.blNo, depositAmountMinor: deposit, ...(existing ? {} : { blNo: targetBl.blNo, customerId: targetBl.customerId, fileNo: targetBl.fileNo, unitId: targetBl.unitId }) },
        reason: input.note,
      },
      now,
    );
    return { targetBlId: targetBl.id, created: !existing };
  });
}

/**
 * An admin takes a transfer back (wrong B/L, entered by mistake) while accounting has not
 * booked it: both entries are compensated, the source returns to its status before, and a B/L
 * the transfer created is voided. Refused once the target has requests or a refund since.
 */
export function reverseTransfer(db: Db, actor: AuthUser, input: { sourceBlId: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.reverseTransfer");
  db.transaction((tx) => {
    const source = requireBl(tx, input.sourceBlId);
    const [out] = activeLedgerEntries(tx, source.id, ["TRANSFER_OUT"]);
    if (!out) throw new DomainError("transfers.errors.noTransfer", { bl: source.blNo });
    const targetBl = requireBl(tx, out.transferBlId!);
    const incoming = activeLedgerEntries(tx, targetBl.id, ["TRANSFER_IN"]).find((e) => e.transferBlId === source.id);
    if (!incoming) throw new DomainError("transfers.errors.noTransfer", { bl: source.blNo });
    if (hasConfirmedAllocation(tx, targetBl.id)) throw new DomainError("transfers.errors.targetMovedOn", { bl: targetBl.blNo });
    const requested = tx
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.blId, targetBl.id), gte(requests.createdAt, incoming.createdAt)))
      .get();
    if (requested) throw new DomainError("transfers.errors.targetMovedOn", { bl: targetBl.blNo });
    const out_audit = tx
      .select({ before: auditLog.before })
      .from(auditLog)
      .where(and(eq(auditLog.action, "bl.transferOut"), eq(auditLog.entityId, String(source.id))))
      .orderBy(desc(auditLog.id))
      .get();
    let status: StoredBlStatus;
    try {
      status = statusAfterTransferReversal(source.status as StoredBlStatus, (out_audit?.before as { status: StoredBlStatus } | null)?.status ?? "PAID");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("transfers.errors.booked", { bl: source.blNo });
      throw error;
    }

    compensateLedgerEntry(tx, out, actor.id, now);
    compensateLedgerEntry(tx, incoming, actor.id, now);
    const at = now.toISOString();
    tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, source.id)).run();
    // A B/L that only existed for this transfer goes with it; one the deposit joined keeps its own.
    const createdByTransfer = targetBl.depositPaymentId === null && blBalance(ledgerOf(tx, targetBl.id), targetBl.currency).depositMinor === 0;
    const deposit = blBalance(ledgerOf(tx, targetBl.id), targetBl.currency).depositMinor;
    tx.update(billsOfLading)
      .set(
        createdByTransfer
          ? { voidedAt: at, voidedBy: actor.id, voidReason: input.reason, updatedAt: at }
          : { depositAmountMinor: deposit, updatedAt: at },
      )
      .where(eq(billsOfLading.id, targetBl.id))
      .run();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "bl.transferReversed", entityType: "bill_of_lading", entityId: source.id, before: { status: source.status }, after: { status, targetBlId: targetBl.id }, reason: input.reason },
      now,
    );
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: createdByTransfer ? "bl.void" : "bl.transferInReversed",
        entityType: "bill_of_lading",
        entityId: targetBl.id,
        after: { sourceBlId: source.id, depositAmountMinor: deposit },
        reason: input.reason,
      },
      now,
    );
  });
}

export type TransferListItem = {
  sourceBlId: number;
  sourceBlNo: string;
  targetBlId: number;
  targetBlNo: string;
  agencyId: number;
  amountMinor: number;
  currency: string;
  transferredOn: string;
  byName: string | null;
};

/** Transfers (not reversed) whose date falls in the period, for the report email. */
export function transfersInPeriod(db: DbOrTx, from: string, to: string, blIds?: number[]): TransferListItem[] {
  const target = billsOfLading;
  const rows = db
    .select({ entry: ledgerEntries, source: billsOfLading, byName: users.displayName })
    .from(ledgerEntries)
    .innerJoin(billsOfLading, eq(billsOfLading.id, ledgerEntries.blId))
    .leftJoin(users, eq(users.id, ledgerEntries.createdBy))
    .where(
      and(
        eq(ledgerEntries.type, "TRANSFER_OUT"),
        isNull(ledgerEntries.compensatesEntryId),
        gte(ledgerEntries.entryDate, from),
        lte(ledgerEntries.entryDate, to),
        blIds ? inArray(ledgerEntries.blId, blIds) : undefined,
      ),
    )
    .all()
    .filter(({ entry }) => activeLedgerEntries(db, entry.blId, ["TRANSFER_OUT"]).some((e) => e.id === entry.id));
  const targets = new Map(
    (rows.length ? db.select({ id: target.id, blNo: target.blNo }).from(target).where(inArray(target.id, rows.map((r) => r.entry.transferBlId!))).all() : []).map((b) => [b.id, b.blNo]),
  );
  return rows.map(({ entry, source, byName }) => ({
    sourceBlId: source.id,
    sourceBlNo: source.blNo,
    targetBlId: entry.transferBlId!,
    targetBlNo: targets.get(entry.transferBlId!) ?? "",
    agencyId: source.agencyId,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    transferredOn: entry.entryDate,
    byName,
  }));
}
