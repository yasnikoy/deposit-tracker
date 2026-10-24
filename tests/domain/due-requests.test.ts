import { describe, expect, it } from "vitest";
import type { BusinessCalendar } from "@/domain/business-days";
import { dueState, type DueInput } from "@/domain/due-requests";

// Tue 20 Oct 2026 payment; 28 Oct half day (not a business day), 29 Oct holiday.
const calendar: BusinessCalendar = {
  weekendDays: [6, 7],
  holidays: new Map([
    ["2026-10-28", "HALF"],
    ["2026-10-29", "FULL"],
  ]),
  halfDaysAreBusinessDays: false,
};

const input = (overrides: Partial<DueInput> = {}): DueInput => ({
  status: "PAID",
  voided: false,
  paidAt: "2026-10-20",
  durations: { firstRequestDueDays: 7, upcomingDays: 2, followUpDays: 5 },
  attempts: 0,
  lastRequestOn: null,
  lastReplyOn: null,
  sending: false,
  ...overrides,
});

describe("first refund request", () => {
  it("is due from payment + first-request duration, and upcoming in the days before", () => {
    // Due Mon 2 Nov. Upcoming while at most 2 business days remain: from Tue 27 Oct on,
    // because 28 and 29 Oct are not business days (only 30 Oct and 2 Nov are left).
    expect(dueState(input(), "2026-10-26", calendar)).toMatchObject({ kind: "FIRST", dueDate: "2026-11-02", list: null });
    expect(dueState(input(), "2026-10-27", calendar)).toMatchObject({ list: "UPCOMING", attemptNo: 1 });
    expect(dueState(input(), "2026-10-31", calendar)).toMatchObject({ list: "UPCOMING" });
    expect(dueState(input(), "2026-11-02", calendar)).toMatchObject({ list: "DUE" });
    expect(dueState(input(), "2026-12-15", calendar)).toMatchObject({ list: "DUE" });
  });

  it("follows the resolved durations (agency or B/L overrides)", () => {
    const quick = input({ durations: { firstRequestDueDays: 1, upcomingDays: 0, followUpDays: 5 } });
    expect(dueState(quick, "2026-10-20", calendar)?.list).toBeNull();
    expect(dueState(quick, "2026-10-21", calendar)?.list).toBe("DUE");
  });
});

describe("follow-ups", () => {
  it("are due after the follow-up interval since the last request when no reply came", () => {
    const requested = input({ status: "REQUESTED", attempts: 1, lastRequestOn: "2026-11-02" });
    // Mon 2 Nov + 5 business days = Mon 9 Nov.
    expect(dueState(requested, "2026-11-05", calendar)).toMatchObject({ kind: "FOLLOW_UP", dueDate: "2026-11-09", list: "UPCOMING", attemptNo: 2 });
    expect(dueState(requested, "2026-11-09", calendar)).toMatchObject({ list: "DUE" });
  });

  it("count from a later reply, e.g. 'container not yet returned'", () => {
    const awaiting = input({ status: "AWAITING_RETURN", attempts: 2, lastRequestOn: "2026-11-02", lastReplyOn: "2026-11-04" });
    expect(dueState(awaiting, "2026-11-11", calendar)).toMatchObject({ dueDate: "2026-11-11", list: "DUE", attemptNo: 3 });
  });

  it("ignore a reply older than the last request", () => {
    const requested = input({ status: "REQUESTED", attempts: 2, lastRequestOn: "2026-11-09", lastReplyOn: "2026-11-04" });
    expect(dueState(requested, "2026-11-10", calendar)?.dueDate).toBe("2026-11-16");
  });
});

describe("nothing is due", () => {
  it("for voided B/Ls, B/Ls with a send in progress, and closed or deduction statuses", () => {
    expect(dueState(input({ voided: true }), "2026-12-01", calendar)).toBeNull();
    expect(dueState(input({ sending: true }), "2026-12-01", calendar)).toBeNull();
    for (const status of ["COLLECTED", "DEDUCTION_OPEN", "DISPUTED"] as const) {
      expect(dueState(input({ status, attempts: 1, lastRequestOn: "2026-11-02" }), "2026-12-01", calendar)).toBeNull();
    }
  });
});
