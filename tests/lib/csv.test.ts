import { describe, expect, it } from "vitest";
import { exportFileName, toCsv, toTsv } from "@/lib/csv";

describe("toCsv", () => {
  it("writes a BOM, semicolons and CRLF lines for Turkish Excel", () => {
    const csv = toCsv({ headers: ["B/L No", "Depozito"], rows: [["HLCU1", "3.000,50"], ["HLCU2", "-700,00"]] });
    expect(csv).toBe("﻿B/L No;Depozito\r\nHLCU1;3.000,50\r\nHLCU2;-700,00\r\n");
  });

  it("quotes cells with separators, quotes or line breaks", () => {
    const csv = toCsv({ headers: ["Not"], rows: [["a;b"], ['say "hi"'], ["line\nbreak"]] });
    expect(csv).toBe('﻿Not\r\n"a;b"\r\n"say ""hi"""\r\n"line\nbreak"\r\n');
  });

  it("keeps text that Excel would run as a formula as plain text; negative amounts stay numbers", () => {
    const csv = toCsv({ headers: ["x"], rows: [["=HYPERLINK(1)"], ["+90 212"], ["@SUM(A1)"], ["-cmd"], ["-1.000,00"]] });
    expect(csv.split("\r\n").slice(1, 6)).toEqual(["'=HYPERLINK(1)", "'+90 212", "'@SUM(A1)", "'-cmd", "-1.000,00"]);
  });
});

describe("toTsv", () => {
  it("puts tabs between cells and flattens tabs and line breaks inside cells", () => {
    expect(toTsv({ headers: ["a", "b"], rows: [["1\t2", "x\r\ny"]] })).toBe("a\tb\r\n1 2\tx y\r\n");
  });

  it("guards formulas like the CSV", () => {
    expect(toTsv({ headers: ["a"], rows: [["=1+1"]] })).toBe("a\r\n'=1+1\r\n");
  });
});

describe("exportFileName", () => {
  it("adds the date and extension", () => {
    expect(exportFileName("tum-bl-ler", "2026-10-31")).toBe("tum-bl-ler-2026-10-31.csv");
  });
});
