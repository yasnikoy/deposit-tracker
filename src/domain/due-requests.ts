import { addBusinessDays, businessDaysBetween, type BusinessCalendar, type IsoDate } from "./business-days";
import type { StoredBlStatus } from "./bl-lifecycle";
import type { RequestType } from "./records";

/** FIRST: first request of its type; FOLLOW_UP: a later request in the same chain. */
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

export type DueState = { type: RequestType; kind: RequestKind; dueDate: IsoDate; list: DueList | null; attemptNo: number };

function onList(today: IsoDate, dueDate: IsoDate, upcomingDays: number, calendar: BusinessCalendar): DueList | null {
  return today >= dueDate ? "DUE" : businessDaysBetween(today, dueDate, calendar) <= upcomingDays ? "UPCOMING" : null;
}

/** The later of the last request and a later answer: the clock restarts from either. */
const followUpBasis = (lastRequestOn: IsoDate, lastReplyOn: IsoDate | null) =>
  lastReplyOn && lastReplyOn > lastRequestOn ? lastReplyOn : lastRequestOn;

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
    dueDate = addBusinessDays(followUpBasis(input.lastRequestOn, input.lastReplyOn), input.durations.followUpDays, calendar);
  } else {
    return null;
  }
  return { type: "REFUND", kind, dueDate, list: onList(today, dueDate, input.durations.upcomingDays, calendar), attemptNo: input.attempts + 1 };
}

export type StatementDurations = { statementRequestDays: number; statementFollowUpDays: number; upcomingDays: number };

export type StatementDueInput = {
  /** Business date the open, undisputed UNEXPLAINED deduction was recorded; null when there is none. */
  unexplainedSince: IsoDate | null;
  durations: StatementDurations;
  /** Deduction-statement requests sent so far on this B/L. */
  attempts: number;
  /** Last statement request sent since the unexplained deduction. */
  lastRequestOn: IsoDate | null;
  /** Business date of the last recorded agency reply that counts as an answer. */
  lastReplyOn: IsoDate | null;
  sending: boolean;
};

/**
 * When the next deduction-statement request of a B/L with an unexplained deduction is due:
 * the statement-request delay after the deduction, then the statement follow-up interval
 * since the last request or a later reply. A disputed deduction is not asked about.
 */
export function statementDueState(input: StatementDueInput, today: IsoDate, calendar: BusinessCalendar): DueState | null {
  if (!input.unexplainedSince || input.sending) return null;
  const { durations } = input;
  const kind: RequestKind = input.lastRequestOn ? "FOLLOW_UP" : "FIRST";
  const dueDate = input.lastRequestOn
    ? addBusinessDays(followUpBasis(input.lastRequestOn, input.lastReplyOn), durations.statementFollowUpDays, calendar)
    : addBusinessDays(input.unexplainedSince, durations.statementRequestDays, calendar);
  return { type: "DEDUCTION_STATEMENT", kind, dueDate, list: onList(today, dueDate, durations.upcomingDays, calendar), attemptNo: input.attempts + 1 };
}
