import { addBusinessDays, businessDaysBetween, type BusinessCalendar, type IsoDate } from "./business-days";
import type { StoredBlStatus } from "./bl-lifecycle";

/** FIRST: first refund request; FOLLOW_UP: a later refund request in the same chain. */
export type RequestKind = "FIRST" | "FOLLOW_UP";
export type DueList = "DUE" | "UPCOMING";

/** Request-timing durations, already resolved: B/L override → agency override → global. */
export type RequestDurations = { firstRequestDueDays: number; upcomingDays: number; followUpDays: number };

export type DueInput = {
  status: StoredBlStatus;
  voided: boolean;
  paidAt: IsoDate;
  durations: RequestDurations;
  /** Refund requests sent (or recorded on a portal) so far. */
  attempts: number;
  /** Business date of the last successful refund request. */
  lastRequestOn: IsoDate | null;
  /** Business date of the last recorded agency reply, if any. */
  lastReplyOn: IsoDate | null;
  /** A request is queued or being sent; it must not be offered twice. */
  sending: boolean;
};

export type DueState = { kind: RequestKind; dueDate: IsoDate; list: DueList | null; attemptNo: number };

/**
 * When the next refund request of a B/L is due, computed on read from events and the
 * current settings (never stored). The first request is due after payment; a follow-up
 * after the follow-up interval since the last request or a later reply, so an agency that
 * never answers is asked again. Upcoming: at most `upcomingDays` business days remain.
 */
export function dueState(input: DueInput, today: IsoDate, calendar: BusinessCalendar): DueState | null {
  if (input.voided || input.sending) return null;

  let kind: RequestKind;
  let dueDate: IsoDate;
  if (input.status === "PAID") {
    kind = "FIRST";
    dueDate = addBusinessDays(input.paidAt, input.durations.firstRequestDueDays, calendar);
  } else if ((input.status === "REQUESTED" || input.status === "AWAITING_RETURN") && input.lastRequestOn) {
    kind = "FOLLOW_UP";
    const basis = input.lastReplyOn && input.lastReplyOn > input.lastRequestOn ? input.lastReplyOn : input.lastRequestOn;
    dueDate = addBusinessDays(basis, input.durations.followUpDays, calendar);
  } else {
    return null;
  }

  const list: DueList | null =
    today >= dueDate ? "DUE" : businessDaysBetween(today, dueDate, calendar) <= input.durations.upcomingDays ? "UPCOMING" : null;
  return { kind, dueDate, list, attemptNo: input.attempts + 1 };
}
