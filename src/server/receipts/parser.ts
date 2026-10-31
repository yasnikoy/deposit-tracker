import "server-only";
// Only text is read, never rendered: pdfjs warnings about canvas support are noise.
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { logger } from "../logger";
import { parseGarantiLines } from "./garanti";

/** Fields read from a bank receipt. Every field is optional and only prefills the form. */
export type ReceiptExtraction = {
  parser: string;
  /** OUT: money we sent (a deposit payment); IN: money we received (a refund). */
  direction?: "OUT" | "IN";
  /** The other party as the bank prints it: the recipient of a payment, the sender of a refund. */
  counterpartyName?: string;
  amountMinor?: number;
  currency?: string;
  date?: string;
  /** Transfer description; searched with agency B/L number patterns. */
  description?: string;
  /** The bank's own reference of the transaction, the same on every copy of the receipt. */
  bankReference?: string;
  /** Our internal file number (e.g. T26-90815) when the description carries one. */
  fileNumber?: string;
};

/** The text of a PDF's first page as lines, top to bottom, parts of a line joined by a space. */
async function pdfLines(content: Buffer): Promise<string[]> {
  const loading = getDocument({ data: new Uint8Array(content), disableFontFace: true, useSystemFonts: false, verbosity: VerbosityLevel.ERRORS });
  try {
    const page = await (await loading.promise).getPage(1);
    const rows = new Map<number, { x: number; text: string }[]>();
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const y = Math.round(item.transform[5]);
      rows.set(y, [...(rows.get(y) ?? []), { x: item.transform[4], text: item.str.trim() }]);
    }
    return [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(" "));
  } finally {
    await loading.destroy();
  }
}

/**
 * Reads a receipt for our bank's layout (Garanti BBVA). Anything else, or a file that is not a
 * readable PDF, yields no fields, so the form is filled in by hand.
 */
export async function parseReceipt(content: Buffer, mimeType: string): Promise<ReceiptExtraction> {
  if (mimeType !== "application/pdf") return { parser: "none" };
  try {
    return parseGarantiLines(await pdfLines(content));
  } catch (error) {
    logger.warn({ err: error }, "receipt could not be read");
    return { parser: "unknown" };
  }
}
