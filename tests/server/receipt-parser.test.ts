import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarantiLines } from "@/server/receipts/garanti";
import { parseReceipt } from "@/server/receipts/parser";

/** The text lines of a Garanti BBVA transfer receipt as pdfjs reads them (names and numbers made up). */
const lines = (overrides: { description?: string[]; amount?: string; recipient?: string } = {}) => [
  "T. Garanti Bankası A.Ş.",
  "Genel Müdürlük: Nispetiye Mah. Aytar Cad. No:2, Beşiktaş, Levent, 34340, İstanbul",
  "Dekont",
  "HESAPTAN HESABA HAVALE",
  "ŞUBE ADI : ÖRNEK SAYIN",
  "MÜŞTERİ NUMARASI : 11111111 ÖRNEK GÜMRÜK MÜŞAVİRLİĞ",
  "HESAP NUMARASI : 111/1111111 ÖRNEK MAH. 1. CAD.",
  "İŞLEM TARİHİ : 19/10/2026",
  "VERGİ DAİRESİ : ÖRNEK VERGİ",
  "VERGİ NO : 1111111111 06000 ÖRNEK/ANKARA",
  "İŞLEM YERİ : INTERNET",
  "DÜZENLENME TARİHİ:19.10.2026",
  "IBAN:TR00 0006 2000 1111 0001 1111 11",
  ...(overrides.description ?? ["MEDUABC12345 - ÖRNEK ENERJİ A.Ş.DEPO T26-90815"]),
  "ALACAKLI ŞUBE : YEDİTEPE KURUMSAL",
  `ALACAKLI HESAP : 01686 / 9084110 ${overrides.recipient ?? "MSC GEMİ ACENTELİĞİ ANONİM ŞİR"}`,
  "ALACAKLI IBAN : TR00 0006 2001 1111 0000 1111 11",
  "YALNIZ İkiBinUSD.%00",
  `SIRA NO : 2026-10-19-13.49.14.035026 TUTAR : ${overrides.amount ?? "- 2.000,00 USD"}`,
  "1 / 1",
];

describe("Garanti receipt parser", () => {
  it("reads an outgoing transfer: date, amount, recipient, description, bank reference and file number", () => {
    expect(parseGarantiLines(lines())).toEqual({
      parser: "garanti",
      direction: "OUT",
      date: "2026-10-19",
      amountMinor: 200000,
      currency: "USD",
      counterpartyName: "MSC GEMİ ACENTELİĞİ ANONİM ŞİR",
      description: "MEDUABC12345 - ÖRNEK ENERJİ A.Ş.DEPO T26-90815",
      bankReference: "2026-10-19-13.49.14.035026",
      fileNumber: "T26-90815",
    });
  });

  it("joins a description over several lines and reads file numbers written without T or in lower case", () => {
    const parsed = parseGarantiLines(lines({ description: ["WAN HAI 903 030G100435", "ÖRNEK ENERJİ DEPO t26-90459"] }));
    expect(parsed.description).toBe("WAN HAI 903 030G100435 ÖRNEK ENERJİ DEPO t26-90459");
    expect(parsed.fileNumber).toBe("T26-90459");
    expect(parseGarantiLines(lines({ description: ["RTM1000098 ÖRNEK DEPO 26-90648"] })).fileNumber).toBe("T26-90648");
    expect(parseGarantiLines(lines({ description: ["MEDUABC12345 ÖRNEK DEPO"] })).fileNumber).toBeUndefined();
  });

  it("an amount without the minus sign is incoming money", () => {
    expect(parseGarantiLines(lines({ amount: "12.520,50 EUR" }))).toMatchObject({ direction: "IN", amountMinor: 1252050, currency: "EUR" });
  });

  it("returns only what it is sure of for another layout", () => {
    expect(parseGarantiLines(["Başka Banka", "Hesap özeti"])).toEqual({ parser: "unknown" });
  });
});

const REAL = path.join(__dirname, "..", "realdata");
const realReceipts = fs.existsSync(REAL) ? fs.readdirSync(REAL).filter((f) => f.toLowerCase().endsWith(".pdf")) : [];

// Real receipts stay out of git (tests/realdata is ignored); this runs only where they exist.
describe.skipIf(realReceipts.length === 0)("real Garanti receipts (local only)", () => {
  it("reads every field of every receipt", async () => {
    for (const file of realReceipts) {
      const parsed = await parseReceipt(fs.readFileSync(path.join(REAL, file)), "application/pdf");
      expect(parsed, file).toMatchObject({ parser: "garanti", direction: "OUT", currency: "USD" });
      expect(parsed.date, file).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(parsed.amountMinor, file).toBeGreaterThan(0);
      expect(parsed.bankReference, file).toMatch(/^\d{4}-\d{2}-\d{2}-/);
      expect(parsed.description, file).toMatch(/DEPO/i);
      expect(parsed.counterpartyName, file).toBeTruthy();
    }
  });
});
