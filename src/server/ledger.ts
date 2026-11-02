import "server-only";
import { and, eq, inArray, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { closingStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import type { DeductionSource, LedgerType } from "@/domain/records";
import type { DbOrTx } from "./db/client";
import { agencies, billsOfLading, ledgerEntries, refundAllocations, refunds } from "./db/schema";

/** Ledger rows are append-only: a correction writes a compensating entry, never an update. */
export type LedgerEntry = typeof ledgerEntries.$inferSelect;

export function addLedgerEntry(
  tx: DbOrTx,
  entry: {
    blId: number;
    type: LedgerType;
    amountMinor: number;
    currency: string;
    entryDate: string;
    depositPaymentId?: number | null;
    refundAllocationId?: number | null;
    deduction?: { typeId: number; source: DeductionSource } | null;
    /** The agency's deduction statement. */
    documentId?: number | null;
    createdBy: number | null;
  },
  now: Date = new Date(),
): LedgerEntry {
  const { deduction, ...rest } = entry;
  return tx
    .insert(ledgerEntries)
    .values({
      ...rest,
      depositPaymentId: entry.depositPaymentId ?? null,
      refundAllocationId: entry.refundAllocationId ?? null,
      documentId: entry.documentId ?? null,
      deductionTypeId: deduction?.typeId ?? null,
      deductionSource: deduction?.source ?? null,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

/**
 * Cancels an entry with its negation; the unique index allows this once per entry. A disputed
 * deduction paid by a later refund is cancelled under that refund's allocation
 * (`byAllocationId`), so reversing the allocation brings the deduction back.
 */
export function compensateLedgerEntry(
  tx: DbOrTx,
  entry: LedgerEntry,
  createdBy: number | null,
  now: Date = new Date(),
  byAllocationId?: number,
): LedgerEntry {
  if (entry.compensatesEntryId !== null) throw new Error("A compensating entry cannot itself be compensated");
  return tx
    .insert(ledgerEntries)
    .values({
      blId: entry.blId,
      type: entry.type,
      amountMinor: -entry.amountMinor,
      currency: entry.currency,
      entryDate: entry.entryDate,
      depositPaymentId: entry.depositPaymentId,
      refundAllocationId: byAllocationId ?? entry.refundAllocationId,
      deductionTypeId: entry.deductionTypeId,
      deductionSource: entry.deductionSource,
      documentId: entry.documentId,
      compensatesEntryId: entry.id,
      createdBy,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

/** Enters a compensated entry again as a new row (append-only), dispute included. */
export function reinstateLedgerEntry(tx: DbOrTx, entry: LedgerEntry, createdBy: number | null, now: Date = new Date()): LedgerEntry {
  if (entry.compensatesEntryId !== null) throw new Error("Only original entries can be reinstated");
  const { id: _id, createdBy: _createdBy, createdAt: _createdAt, ...copy } = entry;
  return tx
    .insert(ledgerEntries)
    .values({ ...copy, createdBy, createdAt: now.toISOString() })
    .returning()
    .get();
}

const compensation = alias(ledgerEntries, "compensation");

/** Entries in effect: neither compensating nor compensated. */
export function activeLedgerEntries(tx: DbOrTx, blId: number, types?: LedgerType[]): LedgerEntry[] {
  const conditions = [
    eq(ledgerEntries.blId, blId),
    isNull(ledgerEntries.compensatesEntryId),
    notExists(tx.select({ id: compensation.id }).from(compensation).where(eq(compensation.compensatesEntryId, ledgerEntries.id))),
  ];
  if (types) conditions.push(inArray(ledgerEntries.type, types));
  return tx.select().from(ledgerEntries).where(and(...conditions)).all();
}

/** Opening-balance entries in effect on active B/Ls, with B/L number and agency name. */
export function activeOpeningEntries(tx: DbOrTx, condition?: SQL) {
  return tx
    .select({
      entryId: ledgerEntries.id,
      blId: billsOfLading.id,
      blNo: billsOfLading.blNo,
      agencyName: agencies.name,
      amountMinor: ledgerEntries.amountMinor,
      currency: ledgerEntries.currency,
      entryDate: ledgerEntries.entryDate,
    })
    .from(ledgerEntries)
    .innerJoin(billsOfLading, eq(billsOfLading.id, ledgerEntries.blId))
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .where(
      and(
        eq(ledgerEntries.type, "OPENING_BALANCE"),
        isNull(ledgerEntries.compensatesEntryId),
        notExists(tx.select({ id: compensation.id }).from(compensation).where(eq(compensation.compensatesEntryId, ledgerEntries.id))),
        isNull(billsOfLading.voidedAt),
        condition,
      ),
    )
    .orderBy(ledgerEntries.entryDate, ledgerEntries.id)
    .all();
}

/** Rules 13/15: money records with a confirmed allocation are frozen. */
export function hasConfirmedAllocation(tx: DbOrTx, blId: number): boolean {
  return activeLedgerEntries(tx, blId, ["REFUND_ALLOCATION"]).length > 0;
}

/** The deposit of a B/L, derived from its ledger (rule 5), in the B/L currency. */
export function ledgerDeposit(tx: DbOrTx, blId: number): number {
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}), 0)` })
    .from(ledgerEntries)
    .innerJoin(billsOfLading, eq(billsOfLading.id, ledgerEntries.blId))
    .where(
      and(
        eq(ledgerEntries.blId, blId),
        inArray(ledgerEntries.type, ["PAYMENT", "OFFSET", "OPENING_BALANCE"]),
        eq(ledgerEntries.currency, billsOfLading.currency),
      ),
    )
    .get();
  return row?.total ?? 0;
}

/**
 * The status a B/L lands on when an event takes it to `to`: a closure waits for the accounting
 * entry when the B/L has an active deduction (any type, write-offs included) or was refunded
 * by an offset (B/L lifecycle). Call it after the closing ledger entries are written.
 */
export function closingStatusFor(tx: DbOrTx, blId: number, to: StoredBlStatus): StoredBlStatus {
  if (to !== "COLLECTED") return to;
  const hasDeduction = activeLedgerEntries(tx, blId, ["DEDUCTION"]).length > 0;
  const hasOffsetRefund = !!tx
    .select({ id: refundAllocations.id })
    .from(refundAllocations)
    .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
    .where(and(eq(refundAllocations.blId, blId), eq(refundAllocations.state, "CONFIRMED"), eq(refunds.kind, "OFFSET")))
    .get();
  return closingStatus(to, { hasDeduction, hasOffsetRefund });
}
