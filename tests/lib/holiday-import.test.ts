import { describe, expect, it } from "vitest";
import { parseHolidayLines } from "@/lib/holiday-import";

describe("parseHolidayLines", () => {
  it("reads tab- or semicolon-separated lines pasted from Excel", () => {
    const text = [
      "28.10.2026\tCumhuriyet Bayramı arifesi\tYarım",
      "29.10.2026;Cumhuriyet Bayramı;Tam",
      "2027-01-01;Yılbaşı",
      "",
    ].join("\n");
    expect(parseHolidayLines(text)).toEqual({
      rows: [
        { line: 1, date: "2026-10-28", name: "Cumhuriyet Bayramı arifesi", kind: "HALF" },
        { line: 2, date: "2026-10-29", name: "Cumhuriyet Bayramı", kind: "FULL" },
        { line: 3, date: "2027-01-01", name: "Yılbaşı", kind: "FULL" },
      ],
      errors: [],
    });
  });

  it("accepts the usual spellings of half and full day", () => {
    const kinds = ["yarim", "YARIM GÜN", "half", "y", "tam gün", "full", "t"].map(
      (kind, i) => parseHolidayLines(`0${i + 1}.01.2027;X;${kind}`).rows[0]?.kind,
    );
    expect(kinds).toEqual(["HALF", "HALF", "HALF", "HALF", "FULL", "FULL", "FULL"]);
  });

  it("reports bad dates, missing names, unknown kinds and duplicates by line", () => {
    const text = ["30.02.2027;Yok", "01.05.2027", "19.05.2027;Bayram;belki", "23.04.2027;A", "23.04.2027;B"].join("\n");
    const result = parseHolidayLines(text);
    expect(result.rows.map((r) => r.line)).toEqual([4]);
    expect(result.errors).toEqual([
      { line: 1, error: "holidays.errors.date" },
      { line: 2, error: "holidays.errors.name" },
      { line: 3, error: "holidays.errors.kind" },
      { line: 5, error: "holidays.errors.duplicate" },
    ]);
  });
});
