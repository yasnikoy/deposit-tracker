import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { isValidBlNumber, normalizeBlNumber } from "@/domain/bl-number";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();

export const requiredReasonSchema = z.string().trim().min(1, msg("payments.errors.reason")).max(500);

export const paymentFields = {
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

const hasNewName = (input: { newAgencyName?: unknown }) => typeof input.newAgencyName === "string" && input.newAgencyName.trim() !== "";
const hasAgency = (input: { agencyId?: unknown; newAgencyName?: unknown }) =>
  (typeof input.agencyId === "number" && input.agencyId > 0) || hasNewName(input);

/**
 * A payment names either an existing agency or, when the agency is not in the system yet,
 * a new agency name; operations completes that agency's card later.
 */
export const createPaymentSchema = z
  .object({
    ...paymentFields,
    agencyId: id.nullable(),
    newAgencyName: z
      .string()
      .trim()
      .max(100, msg("payments.errors.agencyNameLength"))
      .transform((value) => value || null)
      .nullish(),
    kind: z.enum(PAYMENT_KINDS),
    blNoHint,
    // Optional: the receipt or invoice can be attached later (rule 12).
    evidenceDocumentId: id.nullable().default(null),
    queueItemId: id.nullable().default(null),
    confirmDuplicate: z.boolean().default(false),
  })
  .refine((input) => hasAgency(input) && !(input.agencyId !== null && hasNewName(input)), {
    path: ["agencyId"],
    message: msg("payments.errors.agency"),
    // Also when other fields are invalid, so the form shows every error at once.
    when: ({ value }) => typeof value === "object" && value !== null,
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
