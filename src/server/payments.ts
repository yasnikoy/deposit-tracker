import "server-only";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { matchAgencyBySenderName } from "@/domain/agency";
import { extractBlNumbers } from "@/domain/bl-number";
import { istanbulToday } from "@/domain/business-days";
import { EVIDENCE_KIND, type PaymentKind } from "@/domain/records";
import type { CorrectPaymentInput, CreatePaymentInput } from "@/lib/schemas/payments";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx, Tx } from "./db/client";
import {
  agencies,
  billsOfLading,
  currencies,
  depositPayments,
  documents,
  receiptQueue,
} from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, type StoredDocument } from "./files";
import { activeLedgerEntries, addLedgerEntry, compensateLedgerEntry, hasConfirmedAllocation } from "./ledger";
import type { ReceiptExtraction } from "./receipts/parser";
import { getSetting } from "./settings";

export type Payment = typeof depositPayments.$inferSelect;

export type PaymentPrefill = {
  agencyIds: number[];
  amountMinor: number | null;
  currency: string | null;
  paidAt: string | null;
  blCandidates: string[];
};

export type DuplicateCandidate = { id: number; agencyName: string; amountMinor: number; currency: string; paidAt: string };

export type CreatePaymentResult = { status: "created"; id: number } | { status: "duplicate"; duplicates: DuplicateCandidate[] };

/** Turns a receipt extraction into form prefill: agency by sender alias, B/L candidates by agency patterns. */
export function prefillFromExtraction(db: DbOrTx, extraction: ReceiptExtraction): PaymentPrefill {
  const activeAgencies = db
    .select({ id: agencies.id, bankSenderAliases: agencies.bankSenderAliases, blNumberPatterns: agencies.blNumberPatterns })
    .from(agencies)
    .where(eq(agencies.active, true))
    .all();
  const agencyIds = extraction.senderName ? matchAgencyBySenderName(extraction.senderName, activeAgencies) : [];
  const patterns = activeAgencies.filter((a) => agencyIds.length === 0 || agencyIds.includes(a.id)).flatMap((a) => a.blNumberPatterns);
  return {
    agencyIds,
    amountMinor: extraction.amountMinor ?? null,
    currency: extraction.currency ?? null,
    paidAt: extraction.date ?? null,
    blCandidates: extraction.description ? extractBlNumbers(extraction.description, patterns) : [],
  };
}

function findDuplicates(
  tx: DbOrTx,
  input: { agencyId: number; amountMinor: number; currency: string; paidAt: string },
  exceptId?: number,
): DuplicateCandidate[] {
  const conditions = [
    eq(depositPayments.agencyId, input.agencyId),
    eq(depositPayments.amountMinor, input.amountMinor),
    eq(depositPayments.currency, input.currency),
    eq(depositPayments.paidAt, input.paidAt),
    isNull(depositPayments.voidedAt),
  ];
  if (exceptId !== undefined) conditions.push(ne(depositPayments.id, exceptId));
  return tx
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
    .all();
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
 * Opens a deposit payment record (accountant, rule 7) with its mandatory evidence (rule 12).
 * With the duplicate-warning setting on, a record with the same agency, amount, currency and
 * date is reported back and saved only once the user confirms.
 */
export function createPayment(db: Db, actor: AuthUser, input: CreatePaymentInput, now: Date = new Date()): CreatePaymentResult {
  const roleUsed = authorize(actor, "payment.create");
  return db.transaction((tx): CreatePaymentResult => {
    validateReferences(tx, input, now);
    if (!input.confirmDuplicate && getSetting("rules.duplicateWarning", {}, tx)) {
      const duplicates = findDuplicates(tx, input);
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
    const evidence = tx.select().from(documents).where(eq(documents.id, input.evidenceDocumentId)).get();
    if (!evidence || evidence.ownerId !== null) throw new DomainError("payments.errors.evidence");
    const row = tx
      .insert(depositPayments)
      .values({
        agencyId: input.agencyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paidAt: input.paidAt,
        kind: input.kind,
        evidenceDocumentId: input.evidenceDocumentId,
        extractedFields: queueItem?.extracted ?? null,
        extractedBlNumbers: queueItem ? prefillFromExtraction(tx, queueItem.extracted as ReceiptExtraction).blCandidates : [],
        blNoHint: input.blNoHint,
        createdBy: actor.id,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    attachDocument(tx, actor, {
      documentId: input.evidenceDocumentId,
      kind: EVIDENCE_KIND[input.kind],
      ownerType: "deposit_payment",
      ownerId: row.id,
    });
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
    return { status: "created", id: row.id };
  });
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
  };
}

function requirePayment(tx: DbOrTx, id: number): Payment {
  const row = tx.select().from(depositPayments).where(eq(depositPayments.id, id)).get();
  if (!row) throw new DomainError("errors.notFound");
  return row;
}

function activeBlOf(tx: DbOrTx, paymentId: number) {
  return tx
    .select()
    .from(billsOfLading)
    .where(and(eq(billsOfLading.depositPaymentId, paymentId), isNull(billsOfLading.voidedAt)))
    .get();
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

    const bl = activeBlOf(tx, before.id);
    if (bl && hasConfirmedAllocation(tx, bl.id)) throw new DomainError("payments.errors.allocated");

    const at = now.toISOString();
    const after = tx
      .update(depositPayments)
      .set({
        agencyId: input.agencyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paidAt: input.paidAt,
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
    const blAfter = tx
      .update(billsOfLading)
      .set({ agencyId: after.agencyId, currency: after.currency, depositAmountMinor: after.amountMinor, paidAt: after.paidAt, updatedAt: at })
      .where(eq(billsOfLading.id, bl.id))
      .returning()
      .get();
    for (const entry of activeLedgerEntries(tx, bl.id, ["PAYMENT", "OFFSET"])) compensateLedgerEntry(tx, entry, actor.id, now);
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
  });
}

/** Rule 15: voiding a payment requires its B/L to be voided first; never deleted. */
export function voidPayment(db: Db, actor: AuthUser, input: { id: number; reason: string }, now: Date = new Date()): void {
  db.transaction((tx) => {
    const before = requirePayment(tx, input.id);
    const roleUsed = authorize(actor, "payment.void", before);
    if (before.voidedAt) throw new DomainError("payments.errors.voided");
    if (activeBlOf(tx, before.id)) throw new DomainError("payments.errors.voidBlFirst");
    tx.update(depositPayments)
      .set({ voidedAt: now.toISOString(), voidedBy: actor.id, voidReason: input.reason, updatedAt: now.toISOString() })
      .where(eq(depositPayments.id, input.id))
      .run();
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

// ---- Lists ----

export type PaymentListItem = {
  id: number;
  agencyId: number;
  agencyName: string;
  amountMinor: number;
  currency: string;
  paidAt: string;
  kind: PaymentKind;
  evidenceDocumentId: number;
  blNoHint: string | null;
  extractedBlNumbers: string[];
  blId: number | null;
  blNo: string | null;
  createdBy: number;
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
      createdAt: depositPayments.createdAt,
      voidedAt: depositPayments.voidedAt,
      voidReason: depositPayments.voidReason,
    })
    .from(depositPayments)
    .innerJoin(agencies, eq(agencies.id, depositPayments.agencyId))
    .leftJoin(billsOfLading, and(eq(billsOfLading.depositPaymentId, depositPayments.id), isNull(billsOfLading.voidedAt)));
}

/** The accountant's own records, newest first; linked B/L numbers are shown read-only. */
export function listOwnPayments(db: Db, actor: AuthUser): PaymentListItem[] {
  authorize(actor, "payment.viewOwn");
  return paymentListQuery(db).where(eq(depositPayments.createdBy, actor.id)).orderBy(desc(depositPayments.paidAt), desc(depositPayments.id)).all();
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
    .leftJoin(billsOfLading, and(eq(billsOfLading.depositPaymentId, depositPayments.id), isNull(billsOfLading.voidedAt)))
    .where(and(isNull(depositPayments.voidedAt), isNull(billsOfLading.id)))
    .get();
  return row?.n ?? 0;
}
