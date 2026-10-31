import "server-only";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { EVIDENCE_KIND, type PaymentKind } from "@/domain/records";
import type { CorrectRefundInput, CreateRefundInput } from "@/lib/schemas/refunds";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, refundAllocations, refunds } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument } from "./files";
import { validateReferences, type DuplicateCandidate } from "./payments";
import { getSetting } from "./settings";

export type Refund = typeof refunds.$inferSelect;

/**
 * Computed, never stored (rule 3): OPEN without allocations, PARTIALLY_ALLOCATED while money
 * is left, ALLOCATED when nothing is left, REMAINDER_LEFT when operations left the rest
 * unallocated on purpose (with a reason).
 */
export type RefundStatus = "OPEN" | "PARTIALLY_ALLOCATED" | "ALLOCATED" | "REMAINDER_LEFT";

export type CreateRefundResult = { status: "created"; id: number } | { status: "duplicate"; duplicates: DuplicateCandidate[] };

/** Confirmed allocations per refund. */
export function allocatedByRefund(db: DbOrTx, refundIds?: number[]): Map<number, number> {
  const rows = db
    .select({ refundId: refundAllocations.refundId, amountMinor: refundAllocations.amountMinor })
    .from(refundAllocations)
    .where(eq(refundAllocations.state, "CONFIRMED"))
    .all();
  const totals = new Map<number, number>();
  for (const row of rows) {
    if (refundIds && !refundIds.includes(row.refundId)) continue;
    totals.set(row.refundId, (totals.get(row.refundId) ?? 0) + row.amountMinor);
  }
  return totals;
}

export function refundStatus(refund: Pick<Refund, "amountMinor" | "unallocatedReason">, allocatedMinor: number): RefundStatus {
  if (allocatedMinor >= refund.amountMinor) return "ALLOCATED";
  if (refund.unallocatedReason) return "REMAINDER_LEFT";
  return allocatedMinor === 0 ? "OPEN" : "PARTIALLY_ALLOCATED";
}

function findDuplicates(
  tx: DbOrTx,
  input: { agencyId: number; amountMinor: number; currency: string; valueDate: string },
  exceptId?: number,
): DuplicateCandidate[] {
  const conditions = [
    eq(refunds.agencyId, input.agencyId),
    eq(refunds.amountMinor, input.amountMinor),
    eq(refunds.currency, input.currency),
    eq(refunds.valueDate, input.valueDate),
    isNull(refunds.voidedAt),
  ];
  if (exceptId !== undefined) conditions.push(ne(refunds.id, exceptId));
  return tx
    .select({ id: refunds.id, agencyName: agencies.name, amountMinor: refunds.amountMinor, currency: refunds.currency, paidAt: refunds.valueDate })
    .from(refunds)
    .innerJoin(agencies, eq(agencies.id, refunds.agencyId))
    .where(and(...conditions))
    .all();
}

const snapshot = (row: Refund) => ({
  agencyId: row.agencyId,
  amountMinor: row.amountMinor,
  currency: row.currency,
  valueDate: row.valueDate,
  kind: row.kind,
  evidenceDocumentId: row.evidenceDocumentId,
});

/**
 * Enters an incoming refund or offset (accountant, rule 7) with its receipt or invoice
 * (rule 12). The duplicate warning works as for payments.
 */
export function createRefund(db: Db, actor: AuthUser, input: CreateRefundInput, now: Date = new Date()): CreateRefundResult {
  const roleUsed = authorize(actor, "refund.create");
  return db.transaction((tx): CreateRefundResult => {
    validateReferences(tx, { agencyId: input.agencyId, currency: input.currency, paidAt: input.valueDate }, now);
    if (!input.confirmDuplicate && getSetting("rules.duplicateWarning", {}, tx)) {
      const duplicates = findDuplicates(tx, input);
      if (duplicates.length > 0) return { status: "duplicate", duplicates };
    }
    const at = now.toISOString();
    const row = tx
      .insert(refunds)
      .values({
        agencyId: input.agencyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        valueDate: input.valueDate,
        kind: input.kind,
        evidenceDocumentId: input.evidenceDocumentId,
        createdBy: actor.id,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    attachDocument(tx, actor, { documentId: input.evidenceDocumentId, kind: EVIDENCE_KIND[input.kind], ownerType: "refund", ownerId: row.id });
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "refund.create",
        entityType: "refund",
        entityId: row.id,
        after: { ...snapshot(row), duplicateConfirmed: input.confirmDuplicate || undefined },
      },
      now,
    );
    return { status: "created", id: row.id };
  });
}

function requireRefund(tx: DbOrTx, id: number): Refund {
  const row = tx.select().from(refunds).where(eq(refunds.id, id)).get();
  if (!row) throw new DomainError("errors.notFound");
  return row;
}

const hasAllocation = (tx: DbOrTx, refundId: number) =>
  !!tx
    .select({ id: refundAllocations.id })
    .from(refundAllocations)
    .where(and(eq(refundAllocations.refundId, refundId), eq(refundAllocations.state, "CONFIRMED")))
    .get();

/** The accountant corrects an own refund with a reason while it has no confirmed allocation (rule 13). */
export function correctRefund(db: Db, actor: AuthUser, input: CorrectRefundInput, now: Date = new Date()): void {
  db.transaction((tx) => {
    const before = requireRefund(tx, input.id);
    const roleUsed = authorize(actor, "refund.correct", before);
    if (before.voidedAt) throw new DomainError("refunds.errors.voided");
    if (hasAllocation(tx, before.id)) throw new DomainError("refunds.errors.allocated");
    validateReferences(tx, { agencyId: input.agencyId, currency: input.currency, paidAt: input.valueDate }, now, before.agencyId);
    const changes = { agencyId: input.agencyId, amountMinor: input.amountMinor, currency: input.currency, valueDate: input.valueDate };
    const after = tx
      .update(refunds)
      .set({ ...changes, updatedAt: now.toISOString() })
      .where(eq(refunds.id, before.id))
      .returning()
      .get();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "refund.correct", entityType: "refund", entityId: before.id, before: snapshot(before), after: snapshot(after), reason: input.reason },
      now,
    );
  });
}

/** Rule 15: a refund is voided with a reason, only while it has no confirmed allocation. */
export function voidRefund(db: Db, actor: AuthUser, input: { id: number; reason: string }, now: Date = new Date()): void {
  db.transaction((tx) => {
    const before = requireRefund(tx, input.id);
    const roleUsed = authorize(actor, "refund.void", before);
    if (before.voidedAt) throw new DomainError("refunds.errors.voided");
    if (hasAllocation(tx, before.id)) throw new DomainError("refunds.errors.allocated");
    tx.update(refunds)
      .set({ voidedAt: now.toISOString(), voidedBy: actor.id, voidReason: input.reason, updatedAt: now.toISOString() })
      .where(eq(refunds.id, before.id))
      .run();
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "refund.void", entityType: "refund", entityId: before.id, before: snapshot(before), reason: input.reason }, now);
  });
}

export type RefundListItem = {
  id: number;
  agencyId: number;
  agencyName: string;
  amountMinor: number;
  currency: string;
  valueDate: string;
  kind: PaymentKind;
  evidenceDocumentId: number;
  allocatedMinor: number;
  /** Computed: amount − confirmed allocations (rule 3). */
  remainderMinor: number;
  status: RefundStatus;
  unallocatedReason: string | null;
  createdBy: number;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
};

function toListItems(db: DbOrTx, rows: { refund: Refund; agencyName: string }[]): RefundListItem[] {
  const allocated = allocatedByRefund(db);
  return rows.map(({ refund, agencyName }) => {
    const allocatedMinor = allocated.get(refund.id) ?? 0;
    return {
      id: refund.id,
      agencyId: refund.agencyId,
      agencyName,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      valueDate: refund.valueDate,
      kind: refund.kind,
      evidenceDocumentId: refund.evidenceDocumentId,
      allocatedMinor,
      remainderMinor: refund.amountMinor - allocatedMinor,
      status: refundStatus(refund, allocatedMinor),
      unallocatedReason: refund.unallocatedReason,
      createdBy: refund.createdBy,
      createdAt: refund.createdAt,
      voidedAt: refund.voidedAt,
      voidReason: refund.voidReason,
    };
  });
}

const refundRows = (db: DbOrTx) =>
  db.select({ refund: refunds, agencyName: agencies.name }).from(refunds).innerJoin(agencies, eq(agencies.id, refunds.agencyId));

/** The accountant's own refunds, newest first. */
export function listOwnRefunds(db: DbOrTx, actor: AuthUser): RefundListItem[] {
  authorize(actor, "refund.viewOwn");
  return toListItems(db, refundRows(db).where(eq(refunds.createdBy, actor.id)).orderBy(desc(refunds.valueDate), desc(refunds.id)).all());
}

/** Refunds whose rest operations left unallocated on purpose (with a reason), oldest first. */
export function listRefundsWithRemainder(db: DbOrTx, actor: AuthUser): RefundListItem[] {
  authorize(actor, "allocation.view");
  return toListItems(db, refundRows(db).where(isNull(refunds.voidedAt)).orderBy(refunds.valueDate, refunds.id).all()).filter((r) => r.status === "REMAINDER_LEFT");
}

/** Operations work list: active refunds with money still to allocate, oldest first. */
export function listRefundsToAllocate(db: DbOrTx, actor: AuthUser): RefundListItem[] {
  authorize(actor, "allocation.view");
  return toListItems(db, refundRows(db).where(isNull(refunds.voidedAt)).orderBy(refunds.valueDate, refunds.id).all()).filter(
    (r) => r.status === "OPEN" || r.status === "PARTIALLY_ALLOCATED",
  );
}

export function getRefund(db: DbOrTx, id: number): RefundListItem {
  const row = refundRows(db).where(eq(refunds.id, id)).get();
  if (!row) throw new DomainError("errors.notFound");
  return toListItems(db, [row])[0];
}
