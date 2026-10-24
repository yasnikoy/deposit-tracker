import { describe, expect, it } from "vitest";
import { matchBl, parseBlSearch, type SearchableBl } from "@/lib/bl-search";

const bl = (overrides: Partial<SearchableBl> = {}): SearchableBl => ({
  blNo: "MEDU1234567",
  containers: ["MSCU1234565", "CSQU3054383"],
  agencyName: "Şahin Denizcilik",
  depositAmountMinor: 300050,
  ...overrides,
});

describe("parseBlSearch", () => {
  it("treats one term as free text", () => {
    expect(parseBlSearch("  medu12 ")).toEqual({ kind: "text", text: "medu12" });
    expect(parseBlSearch("Şahin Denizcilik")).toEqual({ kind: "text", text: "Şahin Denizcilik" });
  });

  it("treats several pasted numbers as a list, one per line, comma, tab or space", () => {
    expect(parseBlSearch("MEDU1234567\nmedu7654321\r\n")).toEqual({ kind: "list", numbers: ["MEDU1234567", "MEDU7654321"] });
    expect(parseBlSearch("MEDU1234567, CSQU3054383;\tMSCU1234565")).toEqual({
      kind: "list",
      numbers: ["MEDU1234567", "CSQU3054383", "MSCU1234565"],
    });
    expect(parseBlSearch("MEDU1234567 MEDU1234567")).toEqual({ kind: "list", numbers: ["MEDU1234567"] });
  });

  it("keeps words without digits as free text, so agency names still work", () => {
    expect(parseBlSearch("Maersk Line")).toEqual({ kind: "text", text: "Maersk Line" });
  });

  it("is empty for blank input", () => {
    expect(parseBlSearch(" \n ")).toEqual({ kind: "empty" });
  });
});

describe("matchBl", () => {
  const text = (value: string) => matchBl(bl(), parseBlSearch(value));

  it("finds B/L and container numbers by part, ignoring case and spaces", () => {
    expect(text("medu123")).toEqual(["blNo"]);
    expect(text("CSQU 305")).toEqual(["container"]);
  });

  it("finds agencies case- and accent-insensitively", () => {
    expect(text("sahin")).toEqual(["agency"]);
  });

  it("finds deposits by amount in Turkish or plain format", () => {
    expect(text("3.000,50")).toEqual(["amount"]);
    expect(text("3000.50")).toEqual(["amount"]);
    expect(text("3000")).toEqual([]);
    expect(matchBl(bl({ depositAmountMinor: 300000 }), parseBlSearch("3000"))).toEqual(["amount"]);
  });

  it("matches a pasted list only on whole B/L or container numbers", () => {
    expect(matchBl(bl(), parseBlSearch("MEDU1234567\nXXXX0000000"))).toEqual(["blNo"]);
    expect(matchBl(bl(), parseBlSearch("MSCU1234565\nXXXX0000000"))).toEqual(["container"]);
    expect(matchBl(bl(), parseBlSearch("MEDU123\nXXXX0000000"))).toEqual([]);
  });
});
