import { addCalendarDays, isoWeekday, type IsoDate } from "./business-days";

/** Monday of the ISO week (Monday–Sunday) a date falls in. */
const weekOf = (date: IsoDate): IsoDate => addCalendarDays(date, 1 - isoWeekday(date));

/**
 * Which daily backups to keep: the `keepDaily` newest, plus the newest backup of each of the
 * `keepWeekly` newest weeks that have one. Counting weeks with a backup (not calendar weeks)
 * means a PC that was off for a while does not lose its older copies. Everything else may be
 * deleted. Dates are the backups' business dates (one backup per day).
 */
export function backupsToKeep(dates: IsoDate[], counts: { keepDaily: number; keepWeekly: number }): Set<IsoDate> {
  const newestFirst = [...new Set(dates)].sort().reverse();
  const keep = new Set(newestFirst.slice(0, Math.max(0, counts.keepDaily)));
  const weeks = new Set<IsoDate>();
  for (const date of newestFirst) {
    const week = weekOf(date);
    if (weeks.has(week)) continue;
    if (weeks.size >= counts.keepWeekly) break;
    weeks.add(week);
    keep.add(date);
  }
  return keep;
}
