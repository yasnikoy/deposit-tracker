import { describe, expect, it } from "vitest";
import { blNotOnReceipt, extractBlNumbers, matchesBlNumberPattern, validateBlNumberPattern } from "@/domain/bl-number";

const MSC = String.raw`MEDU\d{7}`;
const MAERSK = String.raw`\b2\d{8}\b`;

describe("extractBlNumbers", () => {
  it("finds no candidate", () => {
    expect(extractBlNumbers("DEPOZITO ODEMESI", [MSC])).toEqual([]);
    expect(extractBlNumbers("MEDU1234567", [])).toEqual([]);
  });

  it("finds one candidate in a receipt description, upper-cased", () => {
    expect(extractBlNumbers("Depozito bedeli medu1234567 nolu konşimento", [MSC])).toEqual(["MEDU1234567"]);
  });

  it("finds several candidates across patterns, in order of appearance, without duplicates", () => {
    const text = "B/L 245678901 VE MEDU7654321, TEKRAR MEDU7654321 / medu1111111";
    expect(extractBlNumbers(text, [MSC, MAERSK])).toEqual(["245678901", "MEDU7654321", "MEDU1111111"]);
  });

  it("ignores invalid patterns rather than failing", () => {
    expect(extractBlNumbers("MEDU1234567", ["(", MSC])).toEqual(["MEDU1234567"]);
  });
});

describe("matchesBlNumberPattern", () => {
  it("requires the whole number to match a pattern", () => {
    expect(matchesBlNumberPattern("MEDU1234567", [MSC])).toBe(true);
    expect(matchesBlNumberPattern("medu1234567", [MSC])).toBe(true);
    expect(matchesBlNumberPattern("XMEDU1234567", [MSC])).toBe(false);
    expect(matchesBlNumberPattern("MEDU123456", [MSC])).toBe(false);
  });
});

describe("validateBlNumberPattern", () => {
  it("accepts ordinary patterns", () => {
    expect(validateBlNumberPattern(MSC)).toBeNull();
    expect(validateBlNumberPattern(MAERSK)).toBeNull();
  });

  it("rejects empty, too long, invalid and empty-matching patterns", () => {
    expect(validateBlNumberPattern("  ")).toBe("empty");
    expect(validateBlNumberPattern("A".repeat(201))).toBe("tooLong");
    expect(validateBlNumberPattern("MEDU(")).toBe("invalid");
    expect(validateBlNumberPattern(String.raw`\d*`)).toBe("matchesEmpty");
  });

  it("rejects nested quantifiers that can hang the server", () => {
    expect(validateBlNumberPattern("(A+)+B")).toBe("unsafe");
    expect(validateBlNumberPattern(String.raw`(\d*)*X`)).toBe("unsafe");
    expect(validateBlNumberPattern(String.raw`(\w+\s?)+$`)).toBe("unsafe");
  });
});

describe("blNotOnReceipt", () => {
  it("flags a B/L number the receipt does not name, when the receipt names any", () => {
    expect(blNotOnReceipt("MEDU1111111", ["MEDU2222222"])).toBe(true);
    expect(blNotOnReceipt("medu 2222222", ["MEDU1111111", "MEDU2222222"])).toBe(false);
  });

  it("stays quiet without a typed number or without numbers read from the receipt", () => {
    expect(blNotOnReceipt("", ["MEDU2222222"])).toBe(false);
    expect(blNotOnReceipt("MEDU1111111", [])).toBe(false);
  });
});
