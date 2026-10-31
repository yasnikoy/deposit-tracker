import { describe, expect, it } from "vitest";
import { matchAgencyBySenderName, matchByAliases } from "@/domain/agency";

const customers = [
  { id: 1, aliases: ["ORNEK", "Ornek Enerji"] },
  { id: 2, aliases: ["BETA"] },
  { id: 3, aliases: ["İŞBİR"] },
];

describe("alias matching", () => {
  it("finds a customer in a transfer description, as whole words, ignoring case, Turkish letters and punctuation", () => {
    expect(matchByAliases("MEDUTST10007 - ORNEK ENERJİ A.Ş.DEPO T26-90815", customers)).toEqual([1]);
    expect(matchByAliases("CMA CGM SA -QGD3274600  isbir DEPOZİTO T26-12973", customers)).toEqual([3]);
    expect(matchByAliases("BETAX DEPO", customers)).toEqual([]);
    expect(matchByAliases("", customers)).toEqual([]);
  });

  it("keeps the agency matcher on bank sender aliases", () => {
    expect(matchAgencyBySenderName("MSC GEMİ ACENTELİĞİ ANONİM ŞİR", [{ id: 7, bankSenderAliases: ["MSC GEMI"] }])).toEqual([7]);
  });
});
