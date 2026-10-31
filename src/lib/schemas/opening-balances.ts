import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";
import { blNumberSchema, containerListSchema, fileNoSchema } from "./bls";
import { paymentFields } from "./payments";

const msg = (key: TranslationKey) => key;

/** Most past attempts an Excel record can bring along (a sanity bound, not a business rule). */
const MAX_PAST_ATTEMPTS = 50;

/**
 * An open Excel record moved into the app (admin, rule 7 exception): the deposit as paid, with
 * its original receipt (rule 12), and the refund requests already made outside the app.
 */
export const openingBalanceSchema = z
  .object({
    ...paymentFields,
    kind: z.enum(PAYMENT_KINDS),
    blNo: blNumberSchema,
    containers: containerListSchema,
    customerId: z.number().int().positive().nullable().default(null),
    fileNo: fileNoSchema.nullable().default(null),
    documentId: z
      .number()
      .int()
      .positive()
      .or(z.null())
      .refine((v) => v !== null, msg("openingBalances.errors.receipt"))
      .transform((v) => v as number),
    pastAttempts: z.number(msg("openingBalances.errors.pastAttempts")).int(msg("openingBalances.errors.pastAttempts")).min(0).max(MAX_PAST_ATTEMPTS),
    lastRequestOn: z
      .string()
      .refine(isValidIsoDate, msg("payments.errors.date"))
      .nullable(),
    note: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((value) => value || null),
  })
  .superRefine((input, ctx) => {
    if ((input.pastAttempts > 0) !== (input.lastRequestOn !== null)) {
      ctx.addIssue({ code: "custom", path: ["lastRequestOn"], message: msg("openingBalances.errors.lastRequest") });
    }
  });

export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
