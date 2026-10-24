/** Record enums shared by the database schema, the domain layer and forms. */

export const DOCUMENT_KINDS = [
  "FORM",
  "FORM_TEMPLATE",
  "GENERATED_FORM",
  "RECEIPT",
  "INVOICE",
  "DEDUCTION_STATEMENT",
  "STANDING",
  "OTHER",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** BANK: bank transfer with a receipt; OFFSET: offset against an invoice. */
export const PAYMENT_KINDS = ["BANK", "OFFSET"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Evidence each money record needs (rule 12). */
export const EVIDENCE_KIND: Record<PaymentKind, DocumentKind> = { BANK: "RECEIPT", OFFSET: "INVOICE" };

export const BL_STATUSES = [
  "PAID",
  "DUE",
  "REQUESTED",
  "AWAITING_RETURN",
  "DEDUCTION_OPEN",
  "DISPUTED",
  "COLLECTED",
] as const;
export type BlStatus = (typeof BL_STATUSES)[number];

export const LEDGER_TYPES = ["PAYMENT", "OFFSET", "DEDUCTION", "REFUND_ALLOCATION", "OPENING_BALANCE"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** REFUND: refund request chain; DEDUCTION_STATEMENT: asking for a deduction breakdown (build step 6). */
export const REQUEST_TYPES = ["REFUND", "DEDUCTION_STATEMENT"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** QUEUED: waiting for the sender job; SENT: sent by email or recorded as filed on the portal. */
export const SEND_STATUSES = ["QUEUED", "SENT", "FAILED"] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];
