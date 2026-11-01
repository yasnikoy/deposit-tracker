import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";
import { requiredReasonSchema } from "./payments";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();
const amount = z
  .number(msg("payments.errors.amount"))
  .int(msg("payments.errors.amount"))
  .positive(msg("payments.errors.amount"))
  .refine(Number.isSafeInteger, msg("payments.errors.amount"));

const refundFields = {
  agencyId: id.or(z.null()).refine((v) => v !== null, msg("payments.errors.agency")).transform((v) => v as number),
  // Every refund belongs to exactly one customer; a batched refund never mixes customers.
  customerId: id.or(z.null()).refine((v) => v !== null, msg("refunds.errors.customer")).transform((v) => v as number),
  amountMinor: amount,
  currency: z.string().regex(/^[A-Z]{3}$/, msg("payments.errors.currency")),
  valueDate: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
};

export const createRefundSchema = z.object({
  ...refundFields,
  kind: z.enum(PAYMENT_KINDS),
  // Optional (rule 12): the receipt or invoice can be attached later.
  evidenceDocumentId: id.nullable(),
  confirmDuplicate: z.boolean().default(false),
});
export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export const attachRefundEvidenceSchema = z.object({ refundId: id, documentId: id });

export const correctRefundSchema = z.object({ id, ...refundFields, reason: requiredReasonSchema });
export type CorrectRefundInput = z.infer<typeof correctRefundSchema>;

/**
 * What operations confirms for one refund: the amount per B/L, at most one difference row
 * (the B/L that bears a shortfall, and its deduction type), and a reason when money is left.
 */
export const confirmAllocationSchema = z.object({
  refundId: id,
  lines: z.array(z.object({ blId: id, amountMinor: amount })).min(1).max(200),
  shortfall: z.object({ blId: id, amountMinor: amount, deductionTypeId: id }).nullable(),
  remainderReason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => value || null),
});
export type ConfirmAllocationInput = z.infer<typeof confirmAllocationSchema>;

export const reverseAllocationSchema = z.object({ allocationId: id, reason: requiredReasonSchema });
