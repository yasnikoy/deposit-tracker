import "server-only";

/** Fields read from a bank receipt. Every field is optional and only prefills the form. */
export type ReceiptExtraction = {
  parser: string;
  senderName?: string;
  amountMinor?: number;
  currency?: string;
  date?: string;
  /** Transfer description; searched with agency B/L number patterns. */
  description?: string;
};

/**
 * Receipt parser for our bank's PDF layout. Stubbed until real sample receipts
 * arrive (open item before go-live): it extracts nothing, so every field is
 * entered by hand. The real parser (pdfjs-dist) replaces this function only.
 */
export function parseReceipt(_content: Buffer, _mimeType: string): ReceiptExtraction {
  return { parser: "stub" };
}
