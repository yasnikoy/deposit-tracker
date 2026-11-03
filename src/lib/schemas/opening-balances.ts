import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";
import { blNumberSchema, containerListSchema, fileNoSchema } from "./bls";
import { agencyChoiceFields, agencyChoiceIssue, isAgencyChoice, paymentFields } from "./payments";

const msg = (key: TranslationKey) => key;

/** Most past attempts an Excel record can bring along (a sanity bound, not a business rule). */
const MAX_PAST_ATTEMPTS = 50;

/**
 * An open Excel record moved into the app (admin, rule 7 exception): the agency (or a new one
 * by name, as on a payment), the deposit as paid, its
 * original receipt when at hand (it may be attached later, like a payment's), and the refund
 * requests already made outside the app.
 */
export const openingBalanceSchema = z
  .object({
    ...paymentFields,
    ...agencyChoiceFields,
    kind: z.enum(PAYMENT_KINDS),
    blNo: blNumberSchema,
    // Entered on the B/L detail afterwards; the form sends none.
    containers: containerListSchema.default([]),
    customerId: z.number().int().positive().nullable().default(null),
    // A customer not registered yet, by name (registered with the record).
    newCustomerName: z
      .string()
      .trim()
      .max(200)
      .transform((value) => value || null)
      .nullish(),
    fileNo: fileNoSchema.nullable().default(null),
    documentId: z.number().int().positive().nullable().default(null),
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
    confirmDuplicate: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.customerId !== null && input.newCustomerName) {
      ctx.addIssue({ code: "custom", path: ["customerId"], message: msg("errors.validation") });
    }
    if ((input.pastAttempts > 0) !== (input.lastRequestOn !== null)) {
      ctx.addIssue({ code: "custom", path: ["lastRequestOn"], message: msg("openingBalances.errors.lastRequest") });
    }
  })
  .refine(isAgencyChoice, agencyChoiceIssue);

export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;

/** The receipt (or invoice) a migrated B/L was saved without. */
export const attachOpeningBalanceEvidenceSchema = z.object({ blId: z.number().int().positive(), documentId: z.number().int().positive() });
