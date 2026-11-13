import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { PAYMENT_KINDS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";
import { blNumberSchema } from "./bls";
import { agencyChoiceFields, agencyChoiceIssue, depositCustomerFields, depositDescriptionSchema, isAgencyChoice, paymentFields } from "./payments";

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
    ...depositCustomerFields,
    documentId: z.number().int().positive().nullable().default(null),
    pastAttempts: z.number(msg("openingBalances.errors.pastAttempts")).int(msg("openingBalances.errors.pastAttempts")).min(0).max(MAX_PAST_ATTEMPTS),
    lastRequestOn: z
      .string()
      .refine(isValidIsoDate, msg("payments.errors.date"))
      .nullable(),
    // "Açıklama": the new B/L's description (and the audit reason).
    note: depositDescriptionSchema,
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
