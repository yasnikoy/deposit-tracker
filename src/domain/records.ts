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

export const EMAIL_DIRECTIONS = ["OUT", "IN"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

/** Signature circular (imza sirküleri) and power of attorney (vekaletname), sent with every request. */
export const STANDING_DOCUMENT_SLOTS = ["SIGNATURE_CIRCULAR", "POWER_OF_ATTORNEY"] as const;
export type StandingDocumentSlot = (typeof STANDING_DOCUMENT_SLOTS)[number];

export const JOB_KINDS = ["SEND_EMAIL", "COPY_TO_SENT_FOLDER", "IMAP_POLL", "DAILY_UNPROCESSED_EMAIL"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const MAIL_SERVICES = ["SMTP", "IMAP"] as const;
export type MailService = (typeof MAIL_SERVICES)[number];

/** How an incoming email came to belong to a B/L: its thread, an accepted suggestion, or by hand. */
export const EMAIL_LINK_SOURCES = ["THREAD", "SUGGESTION", "MANUAL"] as const;
export type EmailLinkSource = (typeof EMAIL_LINK_SOURCES)[number];

/** A possible match waits for a user; it is never linked on its own (rule 6). */
export const SUGGESTION_STATES = ["OPEN", "ACCEPTED", "DISMISSED"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

/** Deduction types with behaviour: an unexplained shortfall keeps a B/L open; a write-off needs an admin (step 6b). */
export const DEDUCTION_TYPE_CODES = ["UNEXPLAINED", "WRITE_OFF"] as const;
export type DeductionTypeCode = (typeof DEDUCTION_TYPE_CODES)[number];

/** STATEMENT: from an agency statement before payment; SHORTFALL: a refund paid less; WRITE_OFF: not recovered. */
export const DEDUCTION_SOURCES = ["STATEMENT", "SHORTFALL", "WRITE_OFF"] as const;
export type DeductionSource = (typeof DEDUCTION_SOURCES)[number];

/** A confirmed allocation is reversed only by an admin (rule 8); rows are never deleted. */
export const ALLOCATION_STATES = ["CONFIRMED", "REVERSED"] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];
