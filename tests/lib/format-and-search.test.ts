import { describe, expect, it } from "vitest";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import { matchesSearch, normalizeForSearch } from "@/lib/search";

describe("formatting", () => {
  it("formats business dates as DD.MM.YYYY without shifting the day", () => {
    expect(formatBusinessDate("2026-01-05")).toBe("05.01.2026");
    expect(() => formatBusinessDate("05.01.2026")).toThrow();
  });

  it("formats UTC timestamps in Europe/Istanbul (UTC+3)", () => {
    expect(formatTimestamp("2026-10-22T21:30:00.000Z")).toBe("23.10.2026 00:30");
  });
});

describe("Turkish search", () => {
  it("folds case and Turkish letters", () => {
    expect(normalizeForSearch("İSTANBUL Işık Şule Çağrı Öğüt")).toBe("istanbul isik sule cagri ogut");
    expect(matchesSearch("Şule Yılmaz", "sule yil")).toBe(true);
    expect(matchesSearch("MAERSK", "maersk")).toBe(true);
    expect(matchesSearch("MSC", "cma")).toBe(false);
    expect(matchesSearch("anything", "  ")).toBe(true);
  });
});

describe("t()", () => {
  it("fills placeholders and formats numbers the Turkish way", () => {
    expect(t("table.rowCount", { count: 12500 })).toBe("12.500 kayıt");
    expect(t("dashboard.welcome", { name: "Ayşe" })).toBe("Hoş geldiniz, Ayşe.");
  });
});
