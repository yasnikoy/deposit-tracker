import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { isValidBlNumber, normalizeBlNumber } from "@/domain/bl-number";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();

export const requiredReasonSchema = z.string().trim().min(1, msg("payments.errors.reason")).max(500);

const paymentFields = {
  agencyId: id.or(z.null()).refine((v) => v !== null, msg("payments.errors.agency")).transform((v) => v as number),
  amountMinor: z
    .number(msg("payments.errors.amount"))
    .int(msg("payments.errors.amount"))
    .positive(msg("payments.errors.amount"))
    .refine(Number.isSafeInteger, msg("payments.errors.amount")),
  currency: z.string().regex(/^[A-Z]{3}$/, msg("payments.errors.currency")),
  paidAt: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
};

const blNoHint = z
  .string()
  .trim()
  .max(40)
  .transform((value) => normalizeBlNumber(value) || null)
  .refine((value) => value === null || isValidBlNumber(value), msg("bls.errors.blNo"));

export const createPaymentSchema = z.object({
  ...paymentFields,
  kind: z.enum(PAYMENT_KINDS),
  blNoHint,
  // Optional: the receipt or invoice can be attached later (rule 12).
  evidenceDocumentId: id.nullable().default(null),
  queueItemId: id.nullable().default(null),
  confirmDuplicate: z.boolean().default(false),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/** Corrections cover amount, currency, date and agency; the kind is fixed. */
export const correctPaymentSchema = z.object({
  id,
  ...paymentFields,
  reason: requiredReasonSchema,
});

export type CorrectPaymentInput = z.infer<typeof correctPaymentSchema>;

export const attachEvidenceSchema = z.object({ paymentId: id, documentId: id });

export const voidSchema = z.object({ id, reason: requiredReasonSchema });

export const discardQueueItemSchema = z.object({ id });
