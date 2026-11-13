import "server-only";
import { and, eq, gte, inArray, isNull, lte, desc } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, statusAfterTransferReversal, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday } from "@/domain/business-days";
import { normalizeBlNumber } from "@/domain/bl-number";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
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

export type TransferTarget = {
  /** A new B/L number, or the number of an open B/L of the same agency and currency. */
  blNo: string;
  /** Splitting one source over several targets: this target's part. Otherwise null (the whole deposit). */
  amountMinor: number | null;
  /** For a new B/L only: prefilled from the source in the dialog. */
  customerId: number | null;
  fileNo: string | null;
};

/**
 * One source to one or several targets (its whole deposit split over them), or several
 * sources of the same agency and currency to one target. Never several to several.
 */
export type TransferInput = {
  sourceBlIds: number[];
  targets: TransferTarget[];
  /** When the agency moved the deposit; a new B/L's request clock starts here. */
  transferredOn: string;
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

/** What a transfer of these sources to this number would do, shown in the dialog before saving. */
export function previewTransfer(db: DbOrTx, actor: AuthUser, input: { sourceBlIds: number[]; targetBlNo: string }): TransferPreview {
  authorize(actor, "bl.transferDeposit");
  const sources = input.sourceBlIds.map((id) => requireBl(db, id));
  sameAgencyAndCurrency(sources);
  const amountMinor = sources.reduce((sum, source) => sum + transferable(db, source), 0);
  for (const source of sources.slice(1)) if (normalizeBlNumber(input.targetBlNo) === source.blNo) throw new DomainError("transfers.errors.same");
  return { amountMinor, currency: sources[0].currency, existing: target(db, sources[0], input.targetBlNo) };
}

/** Sources moved together share one agency and currency, as their target must (rule 2). */
function sameAgencyAndCurrency(sources: Bl[]): void {
  const [first] = sources;
  const odd = sources.find((s) => s.agencyId !== first.agencyId || s.currency !== first.currency);
  if (odd) throw new DomainError("transfers.errors.mixedSources", { bl: odd.blNo });
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
 * Moves deposits to other B/Ls, when the agency applied them there instead of refunding
 * (accounting or operations): one source's whole outstanding deposit to one target or split
 * over several, or several sources to one target. Each source settles and waits for the
 * accounting entry (then TRANSFERRED); a target is a new B/L that starts like any other, its
 * request clock from the transfer date, or an open B/L the deposit joins. No money leaves or
 * arrives: each leg is a TRANSFER_OUT on its source and a TRANSFER_IN of the same amount on
 * its target. Requests of a target attach its sources' receipts, under the sources' names.
 */
export function transferDeposit(db: Db, actor: AuthUser, input: TransferInput, now: Date = new Date()): { targets: { blId: number; blNo: string; created: boolean }[] } {
  const roleUsed = authorize(actor, "bl.transferDeposit");
  if (input.sourceBlIds.length === 0 || input.targets.length === 0) throw new DomainError("transfers.errors.split");
  if (input.sourceBlIds.length > 1 && input.targets.length > 1) throw new DomainError("transfers.errors.manyToMany");
  return db.transaction((tx) => {
    const sources = [...new Set(input.sourceBlIds)].map((id) => requireBl(tx, id));
    sameAgencyAndCurrency(sources);
    const whole = new Map(sources.map((source) => [source.id, transferable(tx, source)]));
    for (const source of sources) {
      if (input.transferredOn < source.paidAt) throw new DomainError("transfers.errors.beforePayment");
    }
    if (input.transferredOn > istanbulToday(now)) throw new DomainError("payments.errors.futureDate");
    const targetNos = input.targets.map((x) => normalizeBlNumber(x.blNo));
    if (new Set(targetNos).size !== targetNos.length) throw new DomainError("transfers.errors.duplicateTarget");
    for (const source of sources) if (targetNos.includes(source.blNo)) throw new DomainError("transfers.errors.same");

    // The legs: each source's whole deposit to the one target, or one source split over its targets.
    const legs: { source: Bl; target: TransferTarget; amountMinor: number }[] =
      input.targets.length === 1
        ? sources.map((source) => ({ source, target: input.targets[0], amountMinor: whole.get(source.id)! }))
        : input.targets.map((target) => ({ source: sources[0], target, amountMinor: target.amountMinor ?? 0 }));
    if (input.targets.length > 1) {
      // The whole deposit is split: no part stays behind on the source (partial transfers are not built).
      if (legs.some((leg) => leg.amountMinor <= 0)) throw new DomainError("transfers.errors.split");
      const total = legs.reduce((sum, leg) => sum + leg.amountMinor, 0);
      if (total !== whole.get(sources[0].id)) {
        throw new DomainError("transfers.errors.splitTotal", { total: formatMoney(whole.get(sources[0].id)!, sources[0].currency) });
      }
    }
    // Not while someone drafts a request for a source (rule 14).
    const sourceIds = sources.map((source) => source.id);
    lockForDraft(tx, actor, sourceIds, now);
    releaseDraftLocks(tx, actor, sourceIds);

    const at = now.toISOString();
    const date = formatBusinessDate(input.transferredOn);
    const detail = { currency: sources[0].currency, transferredOn: input.transferredOn };
    const targets = input.targets.map((x) =>
      resolveTarget(tx, actor, roleUsed, sources[0], x, legs.filter((leg) => leg.target === x).reduce((sum, leg) => sum + leg.amountMinor, 0), input, now),
    );
    const statusBefore = new Map(sources.map((source) => [source.id, source.status]));

    for (const leg of legs) {
      const targetBl = targets[input.targets.indexOf(leg.target)].bl;
      const source = requireBl(tx, leg.source.id);
      const fresh = requireBl(tx, targetBl.id);
      addLedgerEntry(tx, { blId: source.id, type: "TRANSFER_OUT", amountMinor: leg.amountMinor, currency: source.currency, entryDate: input.transferredOn, transferBlId: fresh.id, createdBy: actor.id }, now);
      addLedgerEntry(tx, { blId: fresh.id, type: "TRANSFER_IN", amountMinor: leg.amountMinor, currency: source.currency, entryDate: input.transferredOn, transferBlId: source.id, createdBy: actor.id }, now);
      const money = formatMoney(leg.amountMinor, source.currency);
      tx.update(billsOfLading)
        .set({ description: appended(source.description, t("transfers.descriptionOut", { amount: money, bl: fresh.blNo, date })), updatedAt: at })
        .where(eq(billsOfLading.id, source.id))
        .run();
      const deposit = blBalance(ledgerOf(tx, fresh.id), fresh.currency).depositMinor;
      tx.update(billsOfLading)
        .set({ depositAmountMinor: deposit, description: appended(fresh.description, t("transfers.descriptionIn", { amount: money, bl: source.blNo, date })), updatedAt: at })
        .where(eq(billsOfLading.id, fresh.id))
        .run();
      const sourceStatus = nextStatus(statusBefore.get(source.id) as StoredBlStatus, "DEPOSIT_TRANSFERRED");
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "bl.transferOut",
          entityType: "bill_of_lading",
          entityId: source.id,
          // The status before the transfer, the same on every leg: a reversal returns to it.
          before: { status: statusBefore.get(source.id) },
          after: { ...detail, amountMinor: leg.amountMinor, status: sourceStatus, targetBlId: fresh.id, targetBlNo: fresh.blNo },
          reason: input.note,
        },
        now,
      );
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "bl.transferIn",
          entityType: "bill_of_lading",
          entityId: fresh.id,
          before: { depositAmountMinor: fresh.depositAmountMinor },
          after: { ...detail, amountMinor: leg.amountMinor, sourceBlId: source.id, sourceBlNo: source.blNo, depositAmountMinor: deposit },
          reason: input.note,
        },
        now,
      );
    }
    for (const source of sources) {
      const status = nextStatus(statusBefore.get(source.id) as StoredBlStatus, "DEPOSIT_TRANSFERRED");
      tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, source.id)).run();
    }
    return { targets: targets.map(({ bl, created }) => ({ blId: bl.id, blNo: bl.blNo, created })) };
  });
}

/**
 * The B/L a target number names: an open one of the source's agency and currency, which keeps
 * its own details, or a new one with the given customer and file number and the source's unit
 * (audited as created by the transfer, with the deposit its legs bring).
 */
function resolveTarget(
  tx: DbOrTx,
  actor: AuthUser,
  roleUsed: ReturnType<typeof authorize>,
  source: Bl,
  input: TransferTarget,
  incomingMinor: number,
  transfer: TransferInput,
  now: Date,
): { bl: Bl; created: boolean } {
  const existing = target(tx, source, input.blNo);
  if (existing) {
    if (input.customerId !== null || input.fileNo) throw new DomainError("transfers.errors.joinFields", { bl: existing.blNo });
    return { bl: requireBl(tx, existing.blId), created: false };
  }
  if (input.customerId !== null && !tx.select({ active: customers.active }).from(customers).where(eq(customers.id, input.customerId)).get()?.active) {
    throw new DomainError("customers.errors.unknown");
  }
  const at = now.toISOString();
  const bl = tx
    .insert(billsOfLading)
    .values({
      blNo: normalizeBlNumber(input.blNo),
      depositPaymentId: null,
      agencyId: source.agencyId,
      currency: source.currency,
      depositAmountMinor: incomingMinor,
      // The request clock of the new B/L starts at the transfer.
      paidAt: transfer.transferredOn,
      status: "PAID",
      customerId: input.customerId,
      fileNo: input.fileNo,
      // Same agency: the source's unit routes its requests too; it is changed on Talepler or the detail.
      unitId: source.unitId,
      createdBy: actor.id,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: "bl.createFromTransfer",
      entityType: "bill_of_lading",
      entityId: bl.id,
      after: { blNo: bl.blNo, customerId: bl.customerId, fileNo: bl.fileNo, unitId: bl.unitId, transferredOn: transfer.transferredOn },
      reason: transfer.note,
    },
    now,
  );
  return { bl, created: true };
}

/**
 * An admin takes a transfer back (wrong B/L, entered by mistake) while accounting has not
 * booked it: every leg of the source is compensated on both sides, the source returns to its
 * status before, and a B/L the transfer created is voided once nothing else is left on it.
 * Refused once a target has requests or a refund since.
 */
export function reverseTransfer(db: Db, actor: AuthUser, input: { sourceBlId: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.reverseTransfer");
  db.transaction((tx) => {
    const source = requireBl(tx, input.sourceBlId);
    const outs = activeLedgerEntries(tx, source.id, ["TRANSFER_OUT"]);
    if (outs.length === 0) throw new DomainError("transfers.errors.noTransfer", { bl: source.blNo });
    const legs = outs.map((out) => {
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
      return { out, incoming, targetBl };
    });
    const outAudit = tx
      .select({ before: auditLog.before })
      .from(auditLog)
      .where(and(eq(auditLog.action, "bl.transferOut"), eq(auditLog.entityId, String(source.id))))
      .orderBy(desc(auditLog.id))
      .get();
    let status: StoredBlStatus;
    try {
      status = statusAfterTransferReversal(source.status as StoredBlStatus, (outAudit?.before as { status: StoredBlStatus } | null)?.status ?? "PAID");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("transfers.errors.booked", { bl: source.blNo });
      throw error;
    }

    const at = now.toISOString();
    tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, source.id)).run();
    for (const { out, incoming, targetBl } of legs) {
      compensateLedgerEntry(tx, out, actor.id, now);
      compensateLedgerEntry(tx, incoming, actor.id, now);
      // A B/L that only existed for this transfer goes with it; one the deposit joined keeps its own.
      const deposit = blBalance(ledgerOf(tx, targetBl.id), targetBl.currency).depositMinor;
      const createdByTransfer = targetBl.depositPaymentId === null && deposit === 0;
      tx.update(billsOfLading)
        .set(createdByTransfer ? { voidedAt: at, voidedBy: actor.id, voidReason: input.reason, updatedAt: at } : { depositAmountMinor: deposit, updatedAt: at })
        .where(eq(billsOfLading.id, targetBl.id))
        .run();
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
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.transferReversed",
        entityType: "bill_of_lading",
        entityId: source.id,
        before: { status: source.status },
        after: { status, targetBlIds: legs.map((leg) => leg.targetBl.id) },
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
