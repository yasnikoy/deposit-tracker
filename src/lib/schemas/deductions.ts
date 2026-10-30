import { z } from "zod";
import type { TranslationKey } from "@/i18n";
import { requiredReasonSchema } from "./payments";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();
const amount = z
  .number(msg("payments.errors.amount"))
  .int(msg("payments.errors.amount"))
  .positive(msg("payments.errors.amount"))
  .refine(Number.isSafeInteger, msg("payments.errors.amount"));
const optionalNote = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((value) => value || null);

/** Deduction lines of one B/L: a type each, amounts in the B/L currency. */
const lines = z
  .array(z.object({ deductionTypeId: id.or(z.null()).refine((v) => v !== null, msg("deductions.errors.type")).transform((v) => v as number), amountMinor: amount }))
  .min(1)
  .max(20);
export type DeductionLineInput = z.infer<typeof lines>[number];

/** Deductions from an agency statement before payment; the statement is mandatory. */
export const recordStatementDeductionsSchema = z.object({
  blId: id,
  documentId: id.or(z.null()).refine((v) => v !== null, msg("deductions.errors.statementDocument")).transform((v) => v as number),
  lines,
});
export type RecordStatementDeductionsInput = z.infer<typeof recordStatementDeductionsSchema>;

/** Gives an unexplained deduction its real type(s); clearing a dispute needs a note. */
export const classifyDeductionSchema = z.object({
  entryId: id,
  lines,
  documentId: id.nullish().transform((v) => v ?? null),
  note: optionalNote,
});
export type ClassifyDeductionInput = z.infer<typeof classifyDeductionSchema>;

export const disputeDeductionSchema = z.object({ entryId: id, note: requiredReasonSchema });

export const proposeWriteOffSchema = z.object({ blId: id, reason: requiredReasonSchema });
export const approveWriteOffSchema = z.object({ writeOffId: id, note: optionalNote });
export const rejectWriteOffSchema = z.object({ writeOffId: id, reason: requiredReasonSchema });
