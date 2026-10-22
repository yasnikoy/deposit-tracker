import { z } from "zod";
import { isValidIban } from "@/domain/iban";
import type { TranslationKey } from "@/i18n";
import { reasonSchema } from "./holidays";

const msg = (key: TranslationKey) => key;

export const currencyInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, msg("lists.errors.code")),
  name: z.string().trim().min(1, msg("common.required")).max(50),
  active: z.boolean(),
  reason: reasonSchema,
});

export const bankAccountInputSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, msg("common.required")).max(100),
  bankName: z.string().trim().min(1, msg("common.required")).max(100),
  iban: z.string().refine(isValidIban, msg("lists.errors.iban")),
  currency: z.string().regex(/^[A-Z]{3}$/, msg("payments.errors.currency")),
  active: z.boolean(),
  reason: reasonSchema,
});
