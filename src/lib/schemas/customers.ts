import { z } from "zod";
import { STANDING_DOCUMENT_SLOTS } from "@/domain/records";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const MAX_ALIASES = 20;

/** A customer card: the importer we pay deposits for, as staff write it in transfer descriptions. */
export const customerInputSchema = z.object({
  name: z.string().trim().min(1, msg("common.required")).max(200),
  code: z
    .string()
    .trim()
    .max(30, msg("customers.errors.code"))
    .transform((value) => value || null),
  aliases: z.array(z.string().trim().min(1).max(100, msg("customers.errors.alias"))).max(MAX_ALIASES, msg("agencies.errors.tooMany")),
  active: z.boolean(),
});

export type CustomerCardInput = z.infer<typeof customerInputSchema>;

export const createCustomerSchema = customerInputSchema;
export const updateCustomerSchema = z.object({ id: z.number().int().positive(), customer: customerInputSchema });

/** A customer's signature circular or power of attorney, uploaded on its card. */
export const setStandingDocumentSchema = z.object({
  customerId: z.number().int().positive(),
  slot: z.enum(STANDING_DOCUMENT_SLOTS),
  documentId: z.number().int().positive(),
});
