import "server-only";
import type { BusinessCalendar, HolidayKind } from "@/domain/business-days";
import { getDb, type DbOrTx } from "./db/client";
import { holidays } from "./db/schema";
import { getSetting } from "./settings";

/** The business calendar from the weekend and half-day settings and the holidays table. */
export function loadCalendar(db: DbOrTx = getDb()): BusinessCalendar {
  return {
    weekendDays: getSetting("calendar.weekendDays", {}, db),
    halfDaysAreBusinessDays: getSetting("calendar.halfDaysAreBusinessDays", {}, db),
    holidays: new Map(
      db
        .select({ date: holidays.date, kind: holidays.kind })
        .from(holidays)
        .all()
        .map((h) => [h.date, h.kind as HolidayKind]),
    ),
  };
}
