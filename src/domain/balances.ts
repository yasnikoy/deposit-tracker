import type { LedgerType } from "./records";

/** A ledger row as balances see it; compensating rows carry the negated amount. */
export type BalanceEntry = { type: LedgerType; amountMinor: number; currency: string };

export type BlBalance = {
  /** Payment, offset and opening-balance entries. */
  depositMinor: number;
  deductionsMinor: number;
  /** Confirmed refund allocations. */
  collectedMinor: number;
  /** Deposit − deductions − collected: what the agency still owes on this B/L. */
  expectedMinor: number;
};

const DEPOSIT_TYPES: readonly LedgerType[] = ["PAYMENT", "OFFSET", "OPENING_BALANCE"];

/**
 * Rule 5: balances are derived from ledger entries only. Summing every row nets
 * corrections, because a compensating entry cancels the one it references.
 * There is no FX conversion: entries in another currency (left by a currency correction)
 * must cancel out completely.
 */
export function blBalance(entries: readonly BalanceEntry[], currency: string): BlBalance {
  const foreign = new Map<string, number>();
  let depositMinor = 0;
  let deductionsMinor = 0;
  let collectedMinor = 0;
  for (const entry of entries) {
    if (entry.currency !== currency) {
      const key = `${entry.currency}/${entry.type}`;
      foreign.set(key, (foreign.get(key) ?? 0) + entry.amountMinor);
      continue;
    }
    if (DEPOSIT_TYPES.includes(entry.type)) depositMinor += entry.amountMinor;
    else if (entry.type === "DEDUCTION") deductionsMinor += entry.amountMinor;
    else collectedMinor += entry.amountMinor;
  }
  for (const [key, total] of foreign) {
    if (total !== 0) throw new Error(`Uncompensated ${key} entries on a ${currency} B/L: currencies are never mixed`);
  }
  return { depositMinor, deductionsMinor, collectedMinor, expectedMinor: depositMinor - deductionsMinor - collectedMinor };
}
