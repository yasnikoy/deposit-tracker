import "server-only";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { matchAgencyBySenderName } from "@/domain/agency";
import { extractBlNumbers, normalizeBlNumber } from "@/domain/bl-number";
import { istanbulToday } from "@/domain/business-days";
import { DEPOSIT_LEDGER_TYPES, EVIDENCE_KIND, type PaymentKind } from "@/domain/records";
import type { Role } from "@/domain/roles";
import type { CorrectPaymentInput, CreatePaymentInput } from "@/lib/schemas/payments";
import { agencyForNewName } from "./agencies";
import { writeAudit } from "./audit";
import { customerForNewName, suggestCustomer } from "./customers";
import { authorize, can } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx, Tx } from "./db/client";
import {
  agencies,
  billsOfLading,
  currencies,
  customers,
  depositPayments,
  documents,
  ledgerEntries,
  receiptQueue,
  users,
} from "./db/schema";
import { DomainError, ForbiddenError } from "./errors";
import { attachDocument, nameBlDocuments, readDocument, type StoredDocument } from "./files";
import { activeLedgerEntries, activeOpeningEntries, addLedgerEntry, compensateLedgerEntry, hasActiveTransfer, hasConfirmedAllocation } from "./ledger";
import { notify, operationsOnBl } from "./notifications";
import { parseReceipt, type ReceiptExtraction } from "./receipts/parser";
import { getSetting } from "./settings";
import { isSettled, type StoredBlStatus } from "@/domain/bl-lifecycle";

export type Payment = typeof depositPayments.$inferSelect;
type Bl = typeof billsOfLading.$inferSelect;

export type PaymentPrefill = {
  agencyIds: number[];
  amountMinor: number | null;
  currency: string | null;
  paidAt: string | null;
  blCandidates: string[];
  /** The registered customer the description names (only when exactly one matches). */
  customerId: number | null;
  /** Our file number (T26-xxxxx) from the description. */
  fileNo: string | null;
};

/** An earlier deposit with the same agency, amount, currency and date: a payment, or an opening balance (then `blNo` is set). */
export type DuplicateCandidate = { id: number; blNo: string | null; agencyName: string; amountMinor: number; currency: string; paidAt: string };

/** A payment as the server takes it: customer, file number and description may be left out. */
export type NewPayment = Omit<CreatePaymentInput, "customerId" | "newCustomerName" | "fileNo" | "description"> &
  Partial<Pick<CreatePaymentInput, "customerId" | "newCustomerName" | "fileNo" | "description">>;

function requireActiveCustomer(tx: DbOrTx, customerId: number | null) {
  if (customerId !== null && !tx.select({ active: customers.active }).from(customers).where(eq(customers.id, customerId)).get()?.active) {
    throw new DomainError("customers.errors.unknown");
  }
}

export type CreatePaymentResult =
  | { status: "created"; id: number; agencyId: number; /** Set when the payment joined an existing B/L as an additional deposit. */ additionalTo: { blId: number; blNo: string } | null }
  | { status: "duplicate"; duplicates: DuplicateCandidate[] };

/**
 * Turns a receipt extraction into form prefill: agency by sender alias, B/L candidates by
 * agency patterns, customer by customer aliases or name, and our file number.
 */
export function prefillFromExtraction(db: DbOrTx, extraction: ReceiptExtraction): PaymentPrefill {
  const activeAgencies = db
    .select({ id: agencies.id, bankSenderAliases: agencies.bankSenderAliases, blNumberPatterns: agencies.blNumberPatterns })
    .from(agencies)
    .where(eq(agencies.active, true))
    .all();
  const agencyIds = extraction.counterpartyName ? matchAgencyBySenderName(extraction.counterpartyName, activeAgencies) : [];
  const patterns = activeAgencies.filter((a) => agencyIds.length === 0 || agencyIds.includes(a.id)).flatMap((a) => a.blNumberPatterns);
  return {
    agencyIds,
    amountMinor: extraction.amountMinor ?? null,
    currency: extraction.currency ?? null,
    paidAt: extraction.date ?? null,
    blCandidates: extraction.description ? extractBlNumbers(extraction.description, patterns) : [],
    customerId: extraction.description ? suggestCustomer(db, extraction.description) : null,
    fileNo: extraction.fileNumber ?? null,
  };
}

/**
 * Deposits already recorded with the same agency, amount, currency and date (the duplicate
 * warning): active payments and active opening-balance entries of active B/Ls.
 */
export function findDuplicates(
  tx: DbOrTx,
  input: { agencyId: number; amountMinor: number; currency: string; paidAt: string },
  exceptPaymentId?: number,
): DuplicateCandidate[] {
  const conditions = [
    eq(depositPayments.agencyId, input.agencyId),
    eq(depositPayments.amountMinor, input.amountMinor),
    eq(depositPayments.currency, input.currency),
    eq(depositPayments.paidAt, input.paidAt),
    isNull(depositPayments.voidedAt),
  ];
  if (exceptPaymentId !== undefined) conditions.push(ne(depositPayments.id, exceptPaymentId));
  const payments = tx
    .select({
      id: depositPayments.id,
      agencyName: agencies.name,
      amountMinor: depositPayments.amountMinor,
      currency: depositPayments.currency,
      paidAt: depositPayments.paidAt,
    })
    .from(depositPayments)
    .innerJoin(agencies, eq(agencies.id, depositPayments.agencyId))
    .where(and(...conditions))
    .all()
    .map((row) => ({ ...row, blNo: null }));
  const openingBalances = activeOpeningEntries(
    tx,
    and(eq(billsOfLading.agencyId, input.agencyId), eq(ledgerEntries.amountMinor, input.amountMinor), eq(ledgerEntries.currency, input.currency), eq(ledgerEntries.entryDate, input.paidAt)),
  ).map((row) => ({ id: row.entryId, blNo: row.blNo, agencyName: row.agencyName, amountMinor: row.amountMinor, currency: row.currency, paidAt: row.entryDate }));
  return [...payments, ...openingBalances];
}

/** Checks references shared by money records (payments and refunds): agency, currency, date. */
export function validateReferences(
  tx: DbOrTx,
  input: { agencyId: number; currency: string; paidAt: string },
  now: Date,
  allowInactiveAgencyId?: number,
): void {
  const agency = tx.select().from(agencies).where(eq(agencies.id, input.agencyId)).get();
  if (!agency || (!agency.active && agency.id !== allowInactiveAgencyId)) throw new DomainError("payments.errors.agency");
  const currency = tx.select().from(currencies).where(eq(currencies.code, input.currency)).get();
  if (!currency?.active) throw new DomainError("payments.errors.currency");
  if (input.paidAt > istanbulToday(now)) throw new DomainError("payments.errors.futureDate");
}

/**
 * Opens a deposit payment record (accountant, rule 7), with its receipt or invoice when at hand;
 * it may be attached later (rule 12).
 * With the duplicate-warning setting on, a record with the same agency, amount, currency and
 * date is reported back and saved only once the user confirms.
 */
export function createPayment(
  db: Db,
  actor: AuthUser,
  // `extraction` is read on the server from the stored receipt, never taken from the client.
  input: NewPayment & { extraction?: ReceiptExtraction | null },
  now: Date = new Date(),
): CreatePaymentResult {
  const roleUsed = authorize(actor, "payment.create");
  return db.transaction((tx): CreatePaymentResult => {
    const agencyId = input.agencyId ?? agencyForNewName(tx, actor, "agency.createFromPayment", input.newAgencyName ?? "", now);
    validateReferences(tx, { ...input, agencyId }, now);
    if (!input.confirmDuplicate && getSetting("rules.duplicateWarning", {}, tx)) {
      const duplicates = findDuplicates(tx, { ...input, agencyId });
      if (duplicates.length > 0) return { status: "duplicate", duplicates };
    }

    let queueItem: typeof receiptQueue.$inferSelect | undefined;
    if (input.queueItemId !== null) {
      queueItem = tx.select().from(receiptQueue).where(eq(receiptQueue.id, input.queueItemId)).get();
      if (!queueItem || queueItem.createdBy !== actor.id || queueItem.resolvedAt !== null || queueItem.documentId !== input.evidenceDocumentId) {
        throw new DomainError("payments.errors.queueItem");
      }
    }

    const at = now.toISOString();
    if (input.evidenceDocumentId !== null) {
      const evidence = tx.select().from(documents).where(eq(documents.id, input.evidenceDocumentId)).get();
      if (!evidence || evidence.ownerId !== null) throw new DomainError("payments.errors.evidence");
    }
    // A payment that joins an existing B/L brings no customer or file number: the B/L has its own.
    const joining = input.blNoHint ? existingBlFor(tx, input.blNoHint, { agencyId, currency: input.currency }) : null;
    if (joining && (input.customerId || input.newCustomerName || input.fileNo)) throw new DomainError("payments.errors.joinFields", { bl: joining.blNo });
    requireActiveCustomer(tx, input.customerId ?? null);
    const customerId = input.customerId ?? (input.newCustomerName ? customerForNewName(tx, actor, roleUsed, input.newCustomerName, now, { fromPayment: true }) : null);
    const row = tx
      .insert(depositPayments)
      .values({
        agencyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paidAt: input.paidAt,
        kind: input.kind,
        evidenceDocumentId: input.evidenceDocumentId,
        extractedFields: queueItem?.extracted ?? input.extraction ?? null,
        extractedBlNumbers: prefillFromExtraction(tx, (queueItem?.extracted ?? input.extraction ?? { parser: "none" }) as ReceiptExtraction).blCandidates,
        blNoHint: input.blNoHint,
        customerId,
        fileNo: input.fileNo ?? null,
        description: input.description ?? null,
        createdBy: actor.id,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    if (input.evidenceDocumentId !== null) {
      attachDocument(tx, actor, {
        documentId: input.evidenceDocumentId,
        kind: EVIDENCE_KIND[input.kind],
        ownerType: "deposit_payment",
        ownerId: row.id,
      });
    }
    if (queueItem) {
      tx.update(receiptQueue).set({ resolvedAt: at, resolution: "SAVED", paymentId: row.id }).where(eq(receiptQueue.id, queueItem.id)).run();
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "payment.create",
        entityType: "deposit_payment",
        entityId: row.id,
        // A confirmed duplicate warning is a flag, not a reason: reasons are user text.
        after: input.confirmDuplicate ? { ...paymentSnapshot(row), duplicateConfirmed: true } : paymentSnapshot(row),
      },
      now,
    );
    const bl = joining;
    if (bl) tx.update(depositPayments).set({ additionalToBlId: bl.id, updatedAt: at }).where(eq(depositPayments.id, row.id)).run();
    const additionalTo = bl
      ? addDepositToBl(
          tx,
          actor,
          roleUsed,
          bl,
          { type: row.kind === "BANK" ? "PAYMENT" : "OFFSET", amountMinor: row.amountMinor, currency: row.currency, entryDate: row.paidAt, depositPaymentId: row.id },
          // The deposit's description stays with it and shows on the B/L's timeline.
          { action: "bl.additionalPayment", after: { paymentId: row.id }, reason: row.description },
          now,
        )
      : null;
    return { status: "created", id: row.id, agencyId, additionalTo };
  });
}

export type BlJoinProblem = "agency" | "currency" | "closed";

/** The active B/L with this number, if any, and why a deposit could not join it. */
export function joinableBl(tx: DbOrTx, blNo: string, deposit: { agencyId: number | null; currency: string }) {
  const bl = tx
    .select()
    .from(billsOfLading)
    .where(and(eq(sql`upper(${billsOfLading.blNo})`, normalizeBlNumber(blNo)), isNull(billsOfLading.voidedAt)))
    .get();
  if (!bl) return null;
  const problem: BlJoinProblem | null =
    bl.agencyId !== deposit.agencyId ? "agency" : bl.currency !== deposit.currency ? "currency" : isSettled(bl.status as StoredBlStatus) ? "closed" : null;
  return { bl, problem };
}

/**
 * The active B/L a deposit entered with this number joins as an additional deposit ("ek
 * depozito"), or null when no active B/L has the number. Joining needs the same agency and
 * currency and a B/L that is still open.
 */
export function existingBlFor(tx: DbOrTx, blNo: string, deposit: { agencyId: number; currency: string }): Bl | null {
  const found = joinableBl(tx, blNo, deposit);
  if (!found) return null;
  if (found.problem === "closed") throw new DomainError("payments.errors.additionalClosed", { bl: found.bl.blNo });
  if (found.problem) throw new DomainError("payments.errors.additionalMismatch", { bl: found.bl.blNo });
  return found.bl;
}

export type BlJoinPreview = { blId: number; blNo: string; currency: string; depositMinor: number; problem: BlJoinProblem | null };

/**
 * What saving a deposit with this B/L number would do, shown before saving: join the active
 * B/L (with its current deposit) or not, and why not. Payments and opening balances alike.
 */
export function previewBlJoin(db: DbOrTx, actor: AuthUser, input: { blNo: string; agencyId: number | null; currency: string }): BlJoinPreview | null {
  if (!can(actor, "payment.create").allowed && !can(actor, "openingBalance.create").allowed) throw new ForbiddenError();
  const found = joinableBl(db, input.blNo, input);
  if (!found) return null;
  const { bl, problem } = found;
  return { blId: bl.id, blNo: bl.blNo, currency: bl.currency, depositMinor: bl.depositAmountMinor, problem };
}

/**
 * Adds a deposit to an existing B/L (see `existingBlFor`): its own ledger entry adds to the
 * deposit, the B/L's first deposit keeps setting the request clock, and the B/L's documents
 * are renamed. A payment is linked to the B/L (`additionalToBlId`) before this runs.
 */
export function addDepositToBl(
  tx: DbOrTx,
  actor: AuthUser,
  roleUsed: Role | null,
  bl: Bl,
  deposit: { type: "PAYMENT" | "OFFSET" | "OPENING_BALANCE"; amountMinor: number; currency: string; entryDate: string; depositPaymentId: number | null },
  audit: { action: string; after: Record<string, unknown>; reason?: string | null },
  now: Date,
): { blId: number; blNo: string } {
  const at = now.toISOString();
  addLedgerEntry(tx, { blId: bl.id, ...deposit, createdBy: actor.id }, now);
  const after = syncDepositAmount(tx, bl.id, at);
  const renamed = nameBlDocuments(tx, after);
  writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: audit.action,
      entityType: "bill_of_lading",
      entityId: bl.id,
      before: { depositAmountMinor: bl.depositAmountMinor },
      after: { ...audit.after, amountMinor: deposit.amountMinor, paidAt: deposit.entryDate, depositAmountMinor: after.depositAmountMinor, ...(renamed.length ? { renamed } : {}) },
      reason: audit.reason ?? null,
    },
    now,
  );
  return { blId: bl.id, blNo: bl.blNo };
}

function paymentSnapshot(row: Payment) {
  return {
    agencyId: row.agencyId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paidAt: row.paidAt,
    kind: row.kind,
    evidenceDocumentId: row.evidenceDocumentId,
    blNoHint: row.blNoHint,
    customerId: row.customerId,
    fileNo: row.fileNo,
    description: row.description,
  };
}

function requirePayment(tx: DbOrTx, id: number): Payment {
  const row = tx.select().from(depositPayments).where(eq(depositPayments.id, id)).get();
  if (!row) throw new DomainError("errors.notFound");
  return row;
}

/** The active B/L a payment belongs to: as its first payment, or as an additional deposit. */
function activeBlOf(tx: DbOrTx, payment: Pick<Payment, "id" | "additionalToBlId">) {
  return tx
    .select()
    .from(billsOfLading)
    .where(
      and(
        payment.additionalToBlId === null ? eq(billsOfLading.depositPaymentId, payment.id) : eq(billsOfLading.id, payment.additionalToBlId),
        isNull(billsOfLading.voidedAt),
      ),
    )
    .get();
}

/** SQL condition: this B/L row is the payment's (first payment or additional deposit). */
const blOfPayment = or(eq(billsOfLading.depositPaymentId, depositPayments.id), eq(billsOfLading.id, depositPayments.additionalToBlId));

/** Keeps the B/L's stored deposit equal to its active deposit entries (the ledger stays the source). */
function syncDepositAmount(tx: DbOrTx, blId: number, at: string) {
  const total = activeLedgerEntries(tx, blId, [...DEPOSIT_LEDGER_TYPES]).reduce((sum, e) => sum + e.amountMinor, 0);
  return tx.update(billsOfLading).set({ depositAmountMinor: total, updatedAt: at }).where(eq(billsOfLading.id, blId)).returning().get();
}

/** Active payments of a B/L, first payment first, then additional deposits by date. */
export function blPayments(tx: DbOrTx, bl: { id: number; depositPaymentId: number | null }): Payment[] {
  const rows = tx
    .select()
    .from(depositPayments)
    .where(
      and(
        isNull(depositPayments.voidedAt),
        bl.depositPaymentId === null ? eq(depositPayments.additionalToBlId, bl.id) : or(eq(depositPayments.id, bl.depositPaymentId), eq(depositPayments.additionalToBlId, bl.id)),
      ),
    )
    .all();
  return rows.sort((a, b) => Number(b.id === bl.depositPaymentId) - Number(a.id === bl.depositPaymentId) || a.paidAt.localeCompare(b.paidAt) || a.id - b.id);
}

/**
 * Accountant corrects an own payment (amount, currency, date, agency) with a reason,
 * only while it has no confirmed allocation (rule 13). An active B/L follows the correction;
 * its ledger entry is replaced by a compensating entry plus a new one.
 */
export function correctPayment(db: Db, actor: AuthUser, input: CorrectPaymentInput, now: Date = new Date()): void {
  db.transaction((tx: Tx) => {
    const before = requirePayment(tx, input.id);
    const roleUsed = authorize(actor, "payment.correct", before);
    if (before.voidedAt) throw new DomainError("payments.errors.voided");
    validateReferences(tx, input, now, before.agencyId);

    const bl = activeBlOf(tx, before);
    if (bl && hasConfirmedAllocation(tx, bl.id)) throw new DomainError("payments.errors.allocated");
    // A transferred deposit moved on with its amount; correcting it would break the transfer.
    if (bl && hasActiveTransfer(tx, bl.id)) throw new DomainError("payments.errors.transferred", { bl: bl.blNo });
    // A B/L with several payments has one agency and currency: only amount and date can change then.
    if (bl && blPayments(tx, bl).length > 1 && (input.agencyId !== bl.agencyId || input.currency !== bl.currency)) {
      throw new DomainError("payments.errors.additionalMismatch", { bl: bl.blNo });
    }

    // Customer and file number change here only while the payment has no B/L; then on the B/L detail.
    const customerId = input.customerId === undefined ? before.customerId : input.customerId;
    const fileNo = input.fileNo === undefined ? before.fileNo : input.fileNo;
    if (bl && (customerId !== before.customerId || fileNo !== before.fileNo)) throw new DomainError("payments.errors.customerOnBl", { bl: bl.blNo });
    if (customerId !== before.customerId) requireActiveCustomer(tx, customerId);

    const at = now.toISOString();
    const after = tx
      .update(depositPayments)
      .set({
        agencyId: input.agencyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paidAt: input.paidAt,
        customerId,
        fileNo,
        updatedAt: at,
      })
      .where(eq(depositPayments.id, input.id))
      .returning()
      .get();
    if (JSON.stringify(paymentSnapshot(before)) === JSON.stringify(paymentSnapshot(after))) {
      throw new DomainError("payments.errors.noChange");
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "payment.correct",
        entityType: "deposit_payment",
        entityId: input.id,
        before: paymentSnapshot(before),
        after: paymentSnapshot(after),
        reason: input.reason,
      },
      now,
    );

    if (!bl) return;
    // The first payment sets the B/L's agency, currency and date (the request clock); an
    // additional deposit only adds its amount.
    if (bl.depositPaymentId === after.id) {
      tx.update(billsOfLading).set({ agencyId: after.agencyId, currency: after.currency, paidAt: after.paidAt, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
    }
    for (const entry of activeLedgerEntries(tx, bl.id, ["PAYMENT", "OFFSET"]).filter((e) => e.depositPaymentId === after.id)) {
      compensateLedgerEntry(tx, entry, actor.id, now);
    }
    addLedgerEntry(
      tx,
      {
        blId: bl.id,
        type: after.kind === "BANK" ? "PAYMENT" : "OFFSET",
        amountMinor: after.amountMinor,
        currency: after.currency,
        entryDate: after.paidAt,
        depositPaymentId: after.id,
        createdBy: actor.id,
      },
      now,
    );
    const blAfter = syncDepositAmount(tx, bl.id, at);
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.followPaymentCorrection",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { agencyId: bl.agencyId, currency: bl.currency, depositAmountMinor: bl.depositAmountMinor, paidAt: bl.paidAt },
        after: {
          agencyId: blAfter.agencyId,
          currency: blAfter.currency,
          depositAmountMinor: blAfter.depositAmountMinor,
          paidAt: blAfter.paidAt,
        },
        reason: input.reason,
      },
      now,
    );
    notify(
      tx,
      {
        userIds: operationsOnBl(tx, bl.id),
        actorId: actor.id,
        kind: "CORRECTION",
        entityType: "bill_of_lading",
        entityId: bl.id,
        detail: {
          actor: actor.displayName,
          blNo: bl.blNo,
          beforeMinor: bl.depositAmountMinor,
          beforeCurrency: bl.currency,
          afterMinor: blAfter.depositAmountMinor,
          afterCurrency: blAfter.currency,
          reason: input.reason,
        },
      },
      now,
    );
  });
}

/** Rule 15: voiding a payment requires its B/L to be voided first; never deleted. */
export function voidPayment(db: Db, actor: AuthUser, input: { id: number; reason: string }, now: Date = new Date()): void {
  db.transaction((tx) => {
    const before = requirePayment(tx, input.id);
    const roleUsed = authorize(actor, "payment.void", before);
    if (before.voidedAt) throw new DomainError("payments.errors.voided");
    const bl = activeBlOf(tx, before);
    // The B/L's first payment goes only with the B/L; an additional deposit can be voided on its own.
    if (bl && before.additionalToBlId === null) throw new DomainError("payments.errors.voidBlFirst");
    if (bl && hasConfirmedAllocation(tx, bl.id)) throw new DomainError("payments.errors.allocated");
    tx.update(depositPayments)
      .set({ voidedAt: now.toISOString(), voidedBy: actor.id, voidReason: input.reason, updatedAt: now.toISOString() })
      .where(eq(depositPayments.id, input.id))
      .run();
    if (bl) {
      for (const entry of activeLedgerEntries(tx, bl.id, ["PAYMENT", "OFFSET"]).filter((e) => e.depositPaymentId === before.id)) {
        compensateLedgerEntry(tx, entry, actor.id, now);
      }
      const blAfter = syncDepositAmount(tx, bl.id, now.toISOString());
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "bl.additionalPaymentVoided",
          entityType: "bill_of_lading",
          entityId: bl.id,
          before: { depositAmountMinor: bl.depositAmountMinor },
          after: { paymentId: before.id, depositAmountMinor: blAfter.depositAmountMinor },
          reason: input.reason,
        },
        now,
      );
    }
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "payment.void", entityType: "deposit_payment", entityId: input.id, before: paymentSnapshot(before), reason: input.reason },
      now,
    );
  });
}

// ---- Review queue for bulk receipt upload ----

export function enqueueReceipt(tx: DbOrTx, actor: AuthUser, document: StoredDocument, extraction: ReceiptExtraction, now: Date = new Date()): number {
  authorize(actor, "payment.create");
  return tx
    .insert(receiptQueue)
    .values({ documentId: document.id, extracted: extraction, createdBy: actor.id, createdAt: now.toISOString() })
    .returning({ id: receiptQueue.id })
    .get().id;
}

export type QueueItem = {
  id: number;
  documentId: number;
  originalName: string;
  createdAt: string;
  prefill: PaymentPrefill;
};

/** The accountant's own unresolved receipts, oldest first. */
export function listReceiptQueue(db: Db, actor: AuthUser): QueueItem[] {
  authorize(actor, "payment.create");
  return db
    .select({ item: receiptQueue, originalName: documents.originalName })
    .from(receiptQueue)
    .innerJoin(documents, eq(documents.id, receiptQueue.documentId))
    .where(and(eq(receiptQueue.createdBy, actor.id), isNull(receiptQueue.resolvedAt)))
    .orderBy(receiptQueue.id)
    .all()
    .map(({ item, originalName }) => ({
      id: item.id,
      documentId: item.documentId,
      originalName,
      createdAt: item.createdAt,
      prefill: prefillFromExtraction(db, item.extracted as ReceiptExtraction),
    }));
}

export function discardQueueItem(db: Db, actor: AuthUser, input: { id: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "payment.create");
  db.transaction((tx) => {
    const item = tx.select().from(receiptQueue).where(eq(receiptQueue.id, input.id)).get();
    if (!item || item.createdBy !== actor.id || item.resolvedAt) throw new DomainError("payments.errors.queueItem");
    tx.update(receiptQueue).set({ resolvedAt: now.toISOString(), resolution: "DISCARDED" }).where(eq(receiptQueue.id, input.id)).run();
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "receiptQueue.discard", entityType: "document", entityId: item.documentId }, now);
  });
}

/**
 * Attaches the receipt (bank) or invoice (offset) a payment was saved without: by the
 * accountant who entered it, or by operations from the B/L. Any time while the payment is
 * active, also after requests went out (later requests attach it). The file takes the B/L's
 * name, like the other files of a B/L.
 */
export function attachPaymentEvidence(db: Db, actor: AuthUser, input: { paymentId: number; documentId: number }, now: Date = new Date()): void {
  const payment = requirePayment(db, input.paymentId);
  const roleUsed = authorize(actor, "payment.attachEvidence", payment);
  db.transaction((tx) => {
    const current = requirePayment(tx, input.paymentId);
    if (current.voidedAt) throw new DomainError("payments.errors.voided");
    if (current.evidenceDocumentId !== null) throw new DomainError("payments.errors.evidenceExists");
    attachDocument(tx, actor, { documentId: input.documentId, kind: EVIDENCE_KIND[current.kind], ownerType: "deposit_payment", ownerId: current.id });
    tx.update(depositPayments).set({ evidenceDocumentId: input.documentId, updatedAt: now.toISOString() }).where(eq(depositPayments.id, current.id)).run();
    const bl = activeBlOf(tx, current);
    const renamed = bl ? nameBlDocuments(tx, bl) : [];
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "payment.attachEvidence",
        entityType: "deposit_payment",
        entityId: current.id,
        after: { evidenceDocumentId: input.documentId, renamed: renamed.length ? renamed : undefined },
      },
      now,
    );
  });
}

type EvidenceDocument = { id: number; originalName: string; sizeBytes: number; kind: string };

/**
 * The receipts (bank) or invoices (offset) of a B/L's deposit: those of its payments, first
 * payment first, plus those of its opening balances, attached to the B/L itself (first when
 * the B/L was migrated, i.e. has no first payment).
 */
export function depositEvidences(tx: DbOrTx, bl: { id: number; depositPaymentId: number | null }, seen: Set<number> = new Set()): EvidenceDocument[] {
  const fields = { id: documents.id, originalName: documents.originalName, sizeBytes: documents.sizeBytes, kind: documents.kind };
  const own = openingEvidences(tx, bl.id);
  const fromPayments = blPayments(tx, bl)
    .filter((p) => p.evidenceDocumentId !== null)
    .map((p) => tx.select(fields).from(documents).where(eq(documents.id, p.evidenceDocumentId!)).get()!);
  // A deposit transferred in was paid for another B/L: its receipt is that B/L's, kept under its name.
  seen.add(bl.id);
  const transferred = transferSources(tx, bl.id)
    .filter((source) => !seen.has(source.id))
    .flatMap((source) => depositEvidences(tx, source, seen));
  return [...(bl.depositPaymentId === null ? [...own, ...fromPayments] : [...fromPayments, ...own]), ...transferred];
}

/** The B/Ls whose deposit was transferred into this one (not reversed). */
function transferSources(tx: DbOrTx, blId: number) {
  const ids = activeLedgerEntries(tx, blId, ["TRANSFER_IN"]).map((e) => e.transferBlId!);
  return ids.length ? tx.select({ id: billsOfLading.id, depositPaymentId: billsOfLading.depositPaymentId }).from(billsOfLading).where(inArray(billsOfLading.id, ids)).all() : [];
}

/** The receipts or invoices of a B/L's opening balances (owned by the B/L). */
export function openingEvidences(tx: DbOrTx, blId: number): EvidenceDocument[] {
  return tx
    .select({ id: documents.id, originalName: documents.originalName, sizeBytes: documents.sizeBytes, kind: documents.kind })
    .from(documents)
    .where(and(eq(documents.ownerType, "bill_of_lading"), eq(documents.ownerId, blId), inArray(documents.kind, ["RECEIPT", "INVOICE"])))
    .orderBy(documents.id)
    .all();
}

/** How many of a B/L's opening balances still lack their receipt or invoice. */
export function missingOpeningEvidence(tx: DbOrTx, blId: number): number {
  const entries = activeOpeningEntries(tx, eq(billsOfLading.id, blId)).length;
  return Math.max(0, entries - openingEvidences(tx, blId).length);
}

/** The B/L's first receipt or invoice, if any (a migrated B/L's own, or its first payment's). */
export function depositEvidence(tx: DbOrTx, bl: { id: number; depositPaymentId: number | null }): EvidenceDocument | null {
  return depositEvidences(tx, bl)[0] ?? null;
}

/** A B/L with a deposit (payment or opening balance) that has no receipt or invoice yet; requests for it warn (rule 12). */
export function lacksPaymentEvidence(tx: DbOrTx, bl: { id: number; depositPaymentId: number | null }, seen: Set<number> = new Set()): boolean {
  if (blPayments(tx, bl).some((p) => p.evidenceDocumentId === null) || missingOpeningEvidence(tx, bl.id) > 0) return true;
  // A transferred deposit lacks its receipt when the B/L it came from does.
  seen.add(bl.id);
  return transferSources(tx, bl.id).some((source) => !seen.has(source.id) && lacksPaymentEvidence(tx, source, seen));
}

// ---- Lists ----

export type PaymentListItem = {
  id: number;
  agencyId: number;
  agencyName: string;
  customerId: number | null;
  customerName: string | null;
  fileNo: string | null;
  description: string | null;
  amountMinor: number;
  currency: string;
  paidAt: string;
  kind: PaymentKind;
  evidenceDocumentId: number | null;
  blNoHint: string | null;
  extractedBlNumbers: string[];
  blId: number | null;
  blNo: string | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
};

function paymentListQuery(db: DbOrTx) {
  return db
    .select({
      id: depositPayments.id,
      agencyId: depositPayments.agencyId,
      agencyName: agencies.name,
      customerId: depositPayments.customerId,
      customerName: customers.name,
      fileNo: depositPayments.fileNo,
      description: depositPayments.description,
      amountMinor: depositPayments.amountMinor,
      currency: depositPayments.currency,
      paidAt: depositPayments.paidAt,
      kind: depositPayments.kind,
      evidenceDocumentId: depositPayments.evidenceDocumentId,
      blNoHint: depositPayments.blNoHint,
      extractedBlNumbers: depositPayments.extractedBlNumbers,
      blId: billsOfLading.id,
      blNo: billsOfLading.blNo,
      createdBy: depositPayments.createdBy,
      createdByName: users.displayName,
      createdAt: depositPayments.createdAt,
      voidedAt: depositPayments.voidedAt,
      voidReason: depositPayments.voidReason,
    })
    .from(depositPayments)
    .innerJoin(agencies, eq(agencies.id, depositPayments.agencyId))
    .innerJoin(users, eq(users.id, depositPayments.createdBy))
    .leftJoin(customers, eq(customers.id, depositPayments.customerId))
    .leftJoin(billsOfLading, and(blOfPayment, isNull(billsOfLading.voidedAt)));
}

/**
 * Every payment record, newest first, with who entered it; linked B/L numbers are shown
 * read-only. Accountants see each other's work; corrections and voids stay with the
 * record's owner (rule 7).
 */
export function listPayments(db: Db, actor: AuthUser): PaymentListItem[] {
  authorize(actor, "payment.list");
  return paymentListQuery(db).orderBy(desc(depositPayments.paidAt), desc(depositPayments.id)).all();
}

/** Payments without an active B/L, oldest first (operations work list). */
export function listPaymentsAwaitingBl(db: DbOrTx, actor: AuthUser): PaymentListItem[] {
  authorize(actor, "bl.viewAwaiting");
  return paymentListQuery(db)
    .where(and(isNull(depositPayments.voidedAt), isNull(billsOfLading.id)))
    .orderBy(depositPayments.paidAt, depositPayments.id)
    .all();
}

export function countPaymentsAwaitingBl(db: DbOrTx): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(depositPayments)
    .leftJoin(billsOfLading, and(blOfPayment, isNull(billsOfLading.voidedAt)))
    .where(and(isNull(depositPayments.voidedAt), isNull(billsOfLading.id)))
    .get();
  return row?.n ?? 0;
}

/** Reads an uploaded, not yet attached receipt of the actor's again (single upload: the form only got the prefill). */
export async function readUploadedReceipt(db: DbOrTx, actor: AuthUser, documentId: number): Promise<ReceiptExtraction | null> {
  const doc = db.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!doc || doc.uploadedBy !== actor.id || doc.ownerId !== null || doc.kind !== "RECEIPT") return null;
  return parseReceipt(readDocument(doc), doc.mimeType);
}
