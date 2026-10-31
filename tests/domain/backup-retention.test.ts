import { describe, expect, it } from "vitest";
import { addCalendarDays } from "@/domain/business-days";
import { backupsToKeep } from "@/domain/backup-retention";

/** One backup per calendar day, `count` days ending on `last`. */
const days = (last: string, count: number) => Array.from({ length: count }, (_, i) => addCalendarDays(last, -i));

describe("backup retention", () => {
  it("keeps everything while there are fewer backups than the daily count", () => {
    const dates = days("2026-10-31", 5);
    expect([...backupsToKeep(dates, { keepDaily: 14, keepWeekly: 8 })].sort()).toEqual([...dates].sort());
  });

  it("keeps the newest daily copies plus the newest copy of each of the last weeks", () => {
    // Saturday 31 Oct 2026, 70 days of backups.
    const keep = backupsToKeep(days("2026-10-31", 70), { keepDaily: 14, keepWeekly: 8 });
    // The 14 newest: 18 Oct … 31 Oct.
    for (const d of days("2026-10-31", 14)) expect(keep.has(d)).toBe(true);
    expect(keep.has("2026-10-17")).toBe(false);
    // Weekly: the newest backup of each ISO week (Monday–Sunday), 8 weeks back from the newest.
    // Weeks start 26 Oct, 19 Oct, 12 Oct, 5 Oct, 28 Sep, 21 Sep, 14 Sep, 7 Sep: their Sundays.
    for (const d of ["2026-10-11", "2026-10-04", "2026-09-27", "2026-09-20", "2026-09-13"]) expect(keep.has(d)).toBe(true);
    expect(keep.has("2026-09-06")).toBe(false);
    expect(keep.size).toBe(14 + 5);
  });

  it("counts weeks that have a backup, so a PC switched off for weeks keeps older copies", () => {
    const dates = ["2026-10-30", "2026-08-03", "2026-06-01", "2026-05-25"];
    const keep = backupsToKeep(dates, { keepDaily: 1, keepWeekly: 3 });
    expect([...keep].sort()).toEqual(["2026-06-01", "2026-08-03", "2026-10-30"]);
  });

  it("ignores duplicates and keeps nothing with zero counts", () => {
    expect(backupsToKeep(["2026-10-30", "2026-10-30"], { keepDaily: 1, keepWeekly: 0 })).toEqual(new Set(["2026-10-30"]));
    expect(backupsToKeep(["2026-10-30"], { keepDaily: 0, keepWeekly: 0 }).size).toBe(0);
  });
});
