import type { ReceiptExtraction } from "./parser";

/**
 * Garanti BBVA transfer receipts ("Dekont"), read from their text lines top to bottom. Pure:
 * the PDF is turned into lines elsewhere. Only fields read with certainty are returned; the
 * user confirms everything in the form.
 */

const field = (lines: string[], label: string): string | undefined => {
  const line = lines.find((l) => l.startsWith(label));
  return line?.slice(line.indexOf(":") + 1).trim();
};

/** "2.000,00" → 200000 */
const amountMinor = (text: string) => Number(text.replace(/\./g, "").replace(",", ""));

/** Our internal file number as staff write it: "T26-90815", "t26-90815" or "26-90815" → "T26-90815". */
const FILE_NUMBER = /(?<![\p{L}\p{N}])T?(\d{2}-\d{4,6})(?![\p{N}])/iu;

export function parseGarantiLines(lines: string[]): ReceiptExtraction {
  const text = lines.map((l) => l.trim()).filter(Boolean);
  // The title may share a line with the bank's address, depending on the receipt.
  if (!text.some((l) => l.includes("Garanti")) || !text.some((l) => /\bDekont\b/.test(l))) return { parser: "unknown" };
  const result: ReceiptExtraction = { parser: "garanti" };

  const date = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(field(text, "İŞLEM TARİHİ") ?? "");
  if (date) result.date = `${date[3]}-${date[2]}-${date[1]}`;

  const amount = /TUTAR\s*:\s*(-)?\s*([\d.]+,\d{2})\s+([A-Z]{3})/.exec(text.find((l) => l.includes("TUTAR")) ?? "");
  if (amount) {
    result.direction = amount[1] ? "OUT" : "IN";
    result.amountMinor = amountMinor(amount[2]);
    result.currency = amount[3];
  }

  const reference = /SIRA NO\s*:\s*(\S+)/.exec(text.find((l) => l.startsWith("SIRA NO")) ?? "");
  if (reference) result.bankReference = reference[1];

  // "01686 / 9084110 MSC GEMİ ACENTELİĞİ ANONİM ŞİR": branch and account number, then the (cut) name.
  const recipient = /^[\d\s/]+(.+)$/.exec(field(text, "ALACAKLI HESAP") ?? "");
  if (recipient) result.counterpartyName = recipient[1].trim();

  // The transfer description stands between our IBAN and the recipient's branch.
  const from = text.findIndex((l) => l.startsWith("IBAN:"));
  const to = text.findIndex((l) => l.startsWith("ALACAKLI ŞUBE"));
  if (from >= 0 && to > from + 1) {
    result.description = text.slice(from + 1, to).join(" ").replace(/\s+/g, " ");
    const file = FILE_NUMBER.exec(result.description);
    if (file) result.fileNumber = `T${file[1]}`;
  }
  return result;
}
