/**
 * Business-day engine. All app reminders count business days through this module.
 * Dates are business dates as `YYYY-MM-DD` text, interpreted as Europe/Istanbul local dates.
 */

export type IsoDate = string;
export const HOLIDAY_KINDS = ["FULL", "HALF"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

export type BusinessCalendar = {
  /** ISO weekdays that are never business days: 1 = Monday … 7 = Sunday. */
  weekendDays: readonly number[];
  holidays: ReadonlyMap<IsoDate, HolidayKind>;
  /** Whether half-day holidays (arife) count as business days. */
  halfDaysAreBusinessDays: boolean;
};

const DAY_MS = 86_400_000;
// A calendar with no business day for ten years is misconfigured; fail instead of looping.
const MAX_SCAN_DAYS = 3660;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcMs(date: IsoDate): number {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`Invalid business date: ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid business date: ${date}`);
  }
  return ms;
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isValidIsoDate(value: string): boolean {
  try {
    toUtcMs(value);
    return true;
  } catch {
    return false;
  }
}

/** ISO weekday of a business date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay() || 7;
}

export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** The first date on or after `date` that falls on an ISO weekday (1 = Monday … 7 = Sunday). */
export function onOrAfterWeekday(date: IsoDate, weekday: number): IsoDate {
  return addCalendarDays(date, (weekday - isoWeekday(date) + 7) % 7);
}

export function isBusinessDay(date: IsoDate, calendar: BusinessCalendar): boolean {
  if (calendar.weekendDays.includes(isoWeekday(date))) return false;
  const holiday = calendar.holidays.get(date);
  if (holiday === "FULL") return false;
  if (holiday === "HALF") return calendar.halfDaysAreBusinessDays;
  return true;
}

/** The n-th business day after `date` (n = 0 returns `date` unchanged). */
export function addBusinessDays(date: IsoDate, n: number, calendar: BusinessCalendar): IsoDate {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Business day count must be a non-negative integer: ${n}`);
  let ms = toUtcMs(date);
  let remaining = n;
  let scanned = 0;
  while (remaining > 0) {
    ms += DAY_MS;
    if (++scanned > MAX_SCAN_DAYS + n) throw new Error("Calendar has no business days");
    if (isBusinessDay(fromUtcMs(ms), calendar)) remaining--;
  }
  return fromUtcMs(ms);
}

/**
 * Business days after `a` up to and including `b`; negative when `b` is before `a`.
 * Inverse of addBusinessDays: businessDaysBetween(d, addBusinessDays(d, n)) === n.
 */
export function businessDaysBetween(a: IsoDate, b: IsoDate, calendar: BusinessCalendar): number {
  const from = toUtcMs(a);
  const to = toUtcMs(b);
  if (to < from) return -businessDaysBetween(b, a, calendar);
  let count = 0;
  for (let ms = from + DAY_MS; ms <= to; ms += DAY_MS) {
    if (isBusinessDay(fromUtcMs(ms), calendar)) count++;
  }
  return count;
}

const istanbulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's business date in Europe/Istanbul. */
export function istanbulToday(now: Date = new Date()): IsoDate {
  return istanbulDate.format(now);
}

const istanbulWallClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The instant of a wall-clock time (HH:MM) on a business date in Europe/Istanbul. */
export function istanbulInstant(date: IsoDate, time: string): Date {
  const asUtc = new Date(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(istanbulWallClock.formatToParts(asUtc).map((p) => [p.type, p.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(asUtc.getTime() - (wall - asUtc.getTime()));
}
