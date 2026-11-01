import type { BlStatus } from "./records";

/** Statuses held in the database; DUE is derived on read and never stored. */
export type StoredBlStatus = Exclude<BlStatus, "DUE">;

/** Events that move a B/L. */
export type BlEvent =
  | "REFUND_REQUEST_SENT"
  | "NOT_RETURNED_REPLY"
  | "ALLOCATION_SETTLED"
  | "ALLOCATION_UNEXPLAINED"
  | "ALLOCATION_REVERSED"
  | "STATEMENT_SETTLED"
  | "DEDUCTION_DISPUTED"
  | "DEDUCTION_CLASSIFIED"
  | "DIFFERENCE_PAID"
  | "WRITE_OFF_APPROVED"
  | "ACCOUNTING_RECORDED"
  | "ACTION_UNDONE";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: StoredBlStatus,
    public readonly event: BlEvent,
  ) {
    super(`Transition not allowed: ${from} on ${event}`);
    this.name = "InvalidTransitionError";
  }
}

// Rule 9: only the transitions of the lifecycle table; anything else is rejected.
const TRANSITIONS: Record<BlEvent, Partial<Record<StoredBlStatus, StoredBlStatus>>> = {
  REFUND_REQUEST_SENT: {
    PAID: "REQUESTED",
    // A follow-up without a reply keeps the B/L requested.
    REQUESTED: "REQUESTED",
    AWAITING_RETURN: "REQUESTED",
  },
  // Reply type "container not yet returned"; a second one before the next follow-up changes nothing.
  NOT_RETURNED_REPLY: {
    REQUESTED: "AWAITING_RETURN",
    AWAITING_RETURN: "AWAITING_RETURN",
  },
  // Rule 1: confirmed allocations + classified deductions = deposit.
  ALLOCATION_SETTLED: {
    REQUESTED: "COLLECTED",
    AWAITING_RETURN: "COLLECTED",
  },
  // A shortfall marked UNEXPLAINED keeps the B/L open (rule 4).
  ALLOCATION_UNEXPLAINED: {
    REQUESTED: "DEDUCTION_OPEN",
    AWAITING_RETURN: "DEDUCTION_OPEN",
  },
  // Handled by statusAfterReversal: the target depends on the status before the allocation.
  ALLOCATION_REVERSED: {},
  // Rule 1 with no refund: statement deductions take the whole deposit (e.g. applied to an agency invoice).
  STATEMENT_SETTLED: {
    REQUESTED: "COLLECTED",
    AWAITING_RETURN: "COLLECTED",
  },
  DEDUCTION_DISPUTED: {
    DEDUCTION_OPEN: "DISPUTED",
  },
  // Every unexplained deduction got a real type (rule 4); a cleared dispute is accepted this way.
  DEDUCTION_CLASSIFIED: {
    DEDUCTION_OPEN: "COLLECTED",
    DISPUTED: "COLLECTED",
  },
  // A later refund pays the disputed difference.
  DIFFERENCE_PAID: {
    DISPUTED: "COLLECTED",
  },
  // Rule 16: an admin-approved write-off closes the balance of any open B/L.
  // Handled by statusAfterUndo: the target is the status before the undone action.
  ACTION_UNDONE: {},
  WRITE_OFF_APPROVED: {
    PAID: "COLLECTED",
    REQUESTED: "COLLECTED",
    AWAITING_RETURN: "COLLECTED",
    DEDUCTION_OPEN: "COLLECTED",
    DISPUTED: "COLLECTED",
  },
  // An accountant booked the deductions or offset in our accounting software.
  ACCOUNTING_RECORDED: {
    ACCOUNTING_PENDING: "COLLECTED",
  },
};

/**
 * Where a B/L lands when an event closes it: a closure that involved a deduction (any type,
 * write-offs included) or an offset refund waits for an accountant's accounting entry
 * (ACCOUNTING_PENDING); a plain full refund closes at once. Other moves are unchanged.
 */
export function closingStatus(to: StoredBlStatus, involved: { hasDeduction: boolean; hasOffsetRefund: boolean }): StoredBlStatus {
  return to === "COLLECTED" && (involved.hasDeduction || involved.hasOffsetRefund) ? "ACCOUNTING_PENDING" : to;
}

/** Nothing left to collect or request: closed, or settled and waiting only for the accounting entry. */
export const isSettled = (status: StoredBlStatus | "DUE") => status === "COLLECTED" || status === "ACCOUNTING_PENDING";

const REVERSIBLE: readonly StoredBlStatus[] = ["COLLECTED", "ACCOUNTING_PENDING", "DEDUCTION_OPEN", "DISPUTED"];
/** Statuses an allocation starts from: a refund, or the payment of a disputed difference. */
const ALLOCATABLE: readonly StoredBlStatus[] = ["REQUESTED", "AWAITING_RETURN", "DISPUTED"];

/** Rule 8: an admin reversal returns the B/L to the status it had before the allocation. */
export function statusAfterReversal(current: StoredBlStatus, before: StoredBlStatus): StoredBlStatus {
  if (!REVERSIBLE.includes(current) || !ALLOCATABLE.includes(before)) throw new InvalidTransitionError(current, "ALLOCATION_REVERSED");
  return before;
}

export function nextStatus(from: StoredBlStatus, event: BlEvent): StoredBlStatus {
  const to = TRANSITIONS[event][from];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

/**
 * The only status changes an undo may take back (rule 17): a "not yet returned" reply, a
 * settling statement and an accountant's accounting entry.
 */
const UNDOABLE_EVENTS: readonly BlEvent[] = ["NOT_RETURNED_REPLY", "STATEMENT_SETTLED", "ACCOUNTING_RECORDED"];

/** Where an event took the B/L, also when its closure was held for the accounting entry. */
const reaches = (event: BlEvent, before: StoredBlStatus, after: StoredBlStatus) => {
  const to = TRANSITIONS[event][before];
  return to === after || (to === "COLLECTED" && after === "ACCOUNTING_PENDING");
};

/**
 * Undo within the window (rule 17): the B/L returns to its status before the action, but only
 * while it is still where the action left it, and only for a move an undoable event makes.
 * Status moves of allocations, disputes and write-offs are never undone this way (rule 9).
 */
export function statusAfterUndo(s: { current: StoredBlStatus; before: StoredBlStatus; after: StoredBlStatus }): StoredBlStatus {
  if (s.current !== s.after) throw new InvalidTransitionError(s.current, "ACTION_UNDONE");
  if (s.before === s.after) return s.current;
  if (!UNDOABLE_EVENTS.some((event) => reaches(event, s.before, s.after))) throw new InvalidTransitionError(s.current, "ACTION_UNDONE");
  return s.before;
}
