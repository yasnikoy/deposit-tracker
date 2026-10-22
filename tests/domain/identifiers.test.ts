import { describe, expect, it } from "vitest";
import { matchAgencyBySenderName } from "@/domain/agency";
import { normalizeBlNumber, isValidBlNumber } from "@/domain/bl-number";
import { checkContainerNumber, parseContainerList } from "@/domain/containers";
import { isValidIban, normalizeIban } from "@/domain/iban";

describe("container numbers (ISO 6346)", () => {
  it("normalizes and validates format and check digit", () => {
    expect(checkContainerNumber("csqu 305438-3")).toEqual({ value: "CSQU3054383", formatOk: true, checkDigitOk: true });
    expect(checkContainerNumber("MSCU1234567")).toMatchObject({ formatOk: true, checkDigitOk: false });
    expect(checkContainerNumber("MSC1234567")).toMatchObject({ formatOk: false });
    expect(checkContainerNumber("MSCA1234567")).toMatchObject({ formatOk: false }); // category must be U, J or Z
  });

  it("splits a pasted list on commas, spaces, semicolons and new lines, without duplicates", () => {
    expect(parseContainerList("CSQU3054383, csqu 305438-3;MSCU1234567\nTGHU1234568")).toEqual([
      "CSQU3054383",
      "MSCU1234567",
      "TGHU1234568",
    ]);
    expect(parseContainerList("  ")).toEqual([]);
  });
});

describe("B/L numbers", () => {
  it("normalizes case and spaces and checks the allowed characters", () => {
    expect(normalizeBlNumber(" medu 1234567 ")).toBe("MEDU1234567");
    expect(isValidBlNumber("MEDU1234567")).toBe(true);
    expect(isValidBlNumber("HLCU/ABC-123")).toBe(true);
    expect(isValidBlNumber("AB")).toBe(false);
    expect(isValidBlNumber("MEDU#1")).toBe(false);
  });
});

describe("IBAN", () => {
  it("validates the mod-97 checksum", () => {
    expect(normalizeIban("tr33 0006 1005 1978 6457 8413 26")).toBe("TR330006100519786457841326");
    expect(isValidIban("TR330006100519786457841326")).toBe(true);
    expect(isValidIban("TR330006100519786457841327")).toBe(false);
    expect(isValidIban("TR33")).toBe(false);
  });
});

describe("matchAgencyBySenderName", () => {
  const agencies = [
    { id: 1, name: "MSC Türkiye", bankSenderAliases: ["MSC GEMICILIK A.S.", "MEDITERRANEAN SHIPPING"] },
    { id: 2, name: "Maersk", bankSenderAliases: ["MAERSK LINE"] },
    { id: 3, name: "Pasif", bankSenderAliases: ["MAERSK"] },
  ];

  it("matches aliases case- and accent-insensitively, also inside a longer sender name", () => {
    expect(matchAgencyBySenderName("msc gemicilik a.ş.", agencies)).toEqual([1]);
    expect(matchAgencyBySenderName("MEDITERRANEAN SHIPPING CO TR", agencies)).toEqual([1]);
  });

  it("returns every agency that matches, and nothing for an unknown name", () => {
    expect(matchAgencyBySenderName("MAERSK LINE AS", agencies)).toEqual([2, 3]);
    expect(matchAgencyBySenderName("UNKNOWN LTD", agencies)).toEqual([]);
    expect(matchAgencyBySenderName("", agencies)).toEqual([]);
  });
});
