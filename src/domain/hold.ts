import type { IsoDate } from "./business-days";

/** Statuses a B/L can be put on hold from: open, with requests or a statement still to chase. */
export const HOLDABLE = ["PAID", "DUE", "REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN", "DISPUTED"] as const;

/**
 * Whether a B/L is on hold today (Beklemeye al): set by operations, lifted by hand or ending on
 * its review date, when the B/L comes back to the work lists. Computed on read, like DUE.
 */
export function isOnHold(bl: { holdReasonId: number | null; holdUntil: string | null }, today: IsoDate): boolean {
  return bl.holdReasonId !== null && (bl.holdUntil === null || bl.holdUntil > today);
}
