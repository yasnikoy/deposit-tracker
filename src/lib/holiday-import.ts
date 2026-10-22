import type { HolidayKind, IsoDate } from "@/domain/business-days";
import { isValidIsoDate } from "@/domain/business-days";
import type { TranslationKey } from "@/i18n";
import { normalizeForSearch } from "./search";

export type HolidayRow = { line: number; date: IsoDate; name: string; kind: HolidayKind };
export type HolidayLineError = { line: number; error: TranslationKey };

const HALF = new Set(["yarim", "yarim gun", "half", "y", "h"]);
const FULL = new Set(["", "tam", "tam gun", "full", "t", "f"]);

function parseDate(value: string): IsoDate | null {
  const tr = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const iso = tr ? `${tr[3]}-${tr[2].padStart(2, "0")}-${tr[1].padStart(2, "0")}` : value;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Parses holidays pasted one per line: `date ; name ; kind` (tab or semicolon separated).
 * Dates as DD.MM.YYYY or YYYY-MM-DD; kind is optional (full day by default).
 */
export function parseHolidayLines(text: string): { rows: HolidayRow[]; errors: HolidayLineError[] } {
  const rows: HolidayRow[] = [];
  const errors: HolidayLineError[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    const [dateText = "", name = "", kindText = ""] = raw.split(/\t|;/).map((part) => part.trim());

    const date = parseDate(dateText);
    if (!date) return errors.push({ line, error: "holidays.errors.date" });
    if (name === "") return errors.push({ line, error: "holidays.errors.name" });
    const kindKey = normalizeForSearch(kindText);
    const kind: HolidayKind | null = HALF.has(kindKey) ? "HALF" : FULL.has(kindKey) ? "FULL" : null;
    if (!kind) return errors.push({ line, error: "holidays.errors.kind" });
    if (seen.has(date)) return errors.push({ line, error: "holidays.errors.duplicate" });

    seen.add(date);
    rows.push({ line, date, name, kind });
  });

  return { rows, errors };
}
