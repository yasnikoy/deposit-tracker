import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
  istanbulInstant,
  istanbulToday,
  type BusinessCalendar,
} from "@/domain/business-days";

// 2026-10-22 is a Thursday. 28 Oct 2026 is the Republic Day eve (half day), 29 Oct the holiday.
const holidays = new Map([
  ["2026-10-28", "HALF"],
  ["2026-10-29", "FULL"],
  ["2027-01-01", "FULL"],
] as const);

const calendar = (overrides: Partial<BusinessCalendar> = {}): BusinessCalendar => ({
  weekendDays: [6, 7],
  holidays,
  halfDaysAreBusinessDays: false,
  ...overrides,
});

describe("isBusinessDay", () => {
  it("excludes weekend days from settings", () => {
    expect(isBusinessDay("2026-10-23", calendar())).toBe(true); // Fri
    expect(isBusinessDay("2026-10-24", calendar())).toBe(false); // Sat
    expect(isBusinessDay("2026-10-25", calendar())).toBe(false); // Sun
    expect(isBusinessDay("2026-10-24", calendar({ weekendDays: [5, 6] }))).toBe(false); // Sat
    expect(isBusinessDay("2026-10-25", calendar({ weekendDays: [5, 6] }))).toBe(true); // Sun
    expect(isBusinessDay("2026-10-23", calendar({ weekendDays: [5, 6] }))).toBe(false); // Fri
  });

  it("excludes full holidays; half days follow the setting", () => {
    expect(isBusinessDay("2026-10-29", calendar())).toBe(false);
    expect(isBusinessDay("2026-10-28", calendar())).toBe(false);
    expect(isBusinessDay("2026-10-28", calendar({ halfDaysAreBusinessDays: true }))).toBe(true);
    expect(isBusinessDay("2026-10-29", calendar({ halfDaysAreBusinessDays: true }))).toBe(false);
  });
});

describe("addBusinessDays", () => {
  it("returns the n-th business day after the date", () => {
    expect(addBusinessDays("2026-10-22", 1, calendar())).toBe("2026-10-23");
    expect(addBusinessDays("2026-10-23", 1, calendar())).toBe("2026-10-26"); // over the weekend
  });

  it("skips the half-day eve and the holiday (seed: half days are not business days)", () => {
    // Fri 23, Mon 26, Tue 27, (Wed 28 half), (Thu 29 holiday), Fri 30, Mon 2, Tue 3, Wed 4
    expect(addBusinessDays("2026-10-22", 7, calendar())).toBe("2026-11-04");
  });

  it("counts the half day when the setting says so", () => {
    expect(addBusinessDays("2026-10-22", 7, calendar({ halfDaysAreBusinessDays: true }))).toBe("2026-11-03");
  });

  it("uses the configured weekend (Friday–Saturday)", () => {
    expect(addBusinessDays("2026-10-22", 1, calendar({ weekendDays: [5, 6] }))).toBe("2026-10-25");
  });

  it("returns the date itself for n = 0, even on a non-business day", () => {
    expect(addBusinessDays("2026-10-24", 0, calendar())).toBe("2026-10-24");
  });

  it("starts counting from a weekend date", () => {
    expect(addBusinessDays("2026-10-24", 1, calendar())).toBe("2026-10-26");
  });

  it("crosses year ends and leap days", () => {
    expect(addBusinessDays("2026-12-31", 1, calendar())).toBe("2027-01-04");
    expect(addBusinessDays("2028-02-28", 1, calendar())).toBe("2028-02-29");
  });

  it("rejects invalid input", () => {
    expect(() => addBusinessDays("2026-02-30", 1, calendar())).toThrow();
    expect(() => addBusinessDays("22.10.2026", 1, calendar())).toThrow();
    expect(() => addBusinessDays("2026-10-22", -1, calendar())).toThrow();
    expect(() => addBusinessDays("2026-10-22", 1.5, calendar())).toThrow();
  });

  it("refuses a calendar without any business day instead of looping forever", () => {
    expect(() => addBusinessDays("2026-10-22", 1, calendar({ weekendDays: [1, 2, 3, 4, 5, 6, 7] }))).toThrow();
  });
});

describe("businessDaysBetween", () => {
  it("counts business days after a up to and including b", () => {
    expect(businessDaysBetween("2026-10-22", "2026-11-04", calendar())).toBe(7);
    expect(businessDaysBetween("2026-10-22", "2026-10-22", calendar())).toBe(0);
    expect(businessDaysBetween("2026-10-23", "2026-10-25", calendar())).toBe(0); // only the weekend
  });

  it("is negative when b is before a", () => {
    expect(businessDaysBetween("2026-11-04", "2026-10-22", calendar())).toBe(-7);
  });

  it("is the inverse of addBusinessDays", () => {
    for (const cal of [calendar(), calendar({ halfDaysAreBusinessDays: true }), calendar({ weekendDays: [5, 6] })]) {
      for (let n = 0; n <= 40; n++) {
        expect(businessDaysBetween("2026-10-21", addBusinessDays("2026-10-21", n, cal), cal)).toBe(n);
      }
    }
  });
});

describe("istanbulToday", () => {
  it("uses the Europe/Istanbul date, not UTC", () => {
    expect(istanbulToday(new Date("2026-10-22T20:59:59Z"))).toBe("2026-10-22");
    expect(istanbulToday(new Date("2026-10-22T21:00:00Z"))).toBe("2026-10-23");
  });
});

describe("Istanbul wall-clock times", () => {
  it("turns a date and HH:MM in Istanbul into the UTC instant", () => {
    expect(istanbulInstant("2026-10-29", "09:00").toISOString()).toBe("2026-10-29T06:00:00.000Z");
    expect(istanbulInstant("2026-01-01", "00:30").toISOString()).toBe("2025-12-31T21:30:00.000Z");
  });
});
