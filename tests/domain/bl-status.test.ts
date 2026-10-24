import { describe, expect, it } from "vitest";
import { displayStatus, firstRequestDueDate } from "@/domain/bl-status";
import type { BusinessCalendar } from "@/domain/business-days";

// 2026-10-20 is a Tuesday; 28 Oct is a half day, 29 Oct a full holiday.
const calendar: BusinessCalendar = {
  weekendDays: [6, 7],
  holidays: new Map([
    ["2026-10-28", "HALF"],
    ["2026-10-29", "FULL"],
  ]),
  halfDaysAreBusinessDays: false,
};

describe("firstRequestDueDate", () => {
  it("is the n-th business day after payment", () => {
    // Tue 20 Oct + 7 business days skips the weekend and both holidays → Mon 2 Nov.
    expect(firstRequestDueDate("2026-10-20", 7, calendar)).toBe("2026-11-02");
    expect(firstRequestDueDate("2026-10-20", 0, calendar)).toBe("2026-10-20");
  });
});

describe("displayStatus", () => {
  const paid = { status: "PAID" as const, paidAt: "2026-10-20", firstRequestDueDays: 7 };

  it("shows a PAID B/L as DUE from its first-request due date on", () => {
    expect(displayStatus(paid, "2026-10-30", calendar)).toBe("PAID");
    expect(displayStatus(paid, "2026-11-02", calendar)).toBe("DUE");
    expect(displayStatus(paid, "2026-12-01", calendar)).toBe("DUE");
  });

  it("follows the current setting, since due dates are computed on read", () => {
    expect(displayStatus({ ...paid, firstRequestDueDays: 2 }, "2026-10-22", calendar)).toBe("DUE");
  });

  it("never derives DUE for a B/L that has moved on", () => {
    for (const status of ["REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN", "DISPUTED", "COLLECTED"] as const) {
      expect(displayStatus({ ...paid, status }, "2027-01-01", calendar)).toBe(status);
    }
  });
});
