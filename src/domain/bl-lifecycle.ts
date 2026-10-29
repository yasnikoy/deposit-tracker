import type { BlStatus } from "./records";

/** Statuses held in the database; DUE is derived on read and never stored. */
export type StoredBlStatus = Exclude<BlStatus, "DUE">;

/** Events that move a B/L. Later build steps add replies, allocations, deductions and disputes. */
export type BlEvent = "REFUND_REQUEST_SENT" | "NOT_RETURNED_REPLY";

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
};

export function nextStatus(from: StoredBlStatus, event: BlEvent): StoredBlStatus {
  const to = TRANSITIONS[event][from];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}
