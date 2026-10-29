import "server-only";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DeductionSource, LedgerType } from "@/domain/records";
import type { DbOrTx } from "./db/client";
import { billsOfLading, ledgerEntries } from "./db/schema";

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
      deductionTypeId: deduction?.typeId ?? null,
      deductionSource: deduction?.source ?? null,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

/** Cancels an entry with its negation; the unique index allows this once per entry. */
export function compensateLedgerEntry(tx: DbOrTx, entry: LedgerEntry, createdBy: number | null, now: Date = new Date()): LedgerEntry {
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
      refundAllocationId: entry.refundAllocationId,
      deductionTypeId: entry.deductionTypeId,
      deductionSource: entry.deductionSource,
      compensatesEntryId: entry.id,
      createdBy,
      createdAt: now.toISOString(),
    })
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
