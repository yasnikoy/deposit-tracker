// Display formatting only; stored values stay ISO text / integer minor units.
export const APP_TIME_ZONE = "Europe/Istanbul";

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Business date `YYYY-MM-DD` → `DD.MM.YYYY` (no time zone shift: it is already a local date). */
export function formatBusinessDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid business date: ${value}`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** UTC ISO-8601 timestamp → `DD.MM.YYYY HH:mm` in Europe/Istanbul. */
export function formatTimestamp(value: string): string {
  const parts = Object.fromEntries(
    dateTimeFormat.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

/** A file or database size in Turkish format with its unit: B, KB, MB, GB or TB. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
