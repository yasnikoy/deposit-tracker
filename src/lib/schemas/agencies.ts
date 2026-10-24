import { z } from "zod";
import { REQUEST_CHANNELS } from "@/domain/agency";
import { validateBlNumberPattern } from "@/domain/bl-number";
import {
  OVERRIDABLE_SETTING_KEYS,
  settingDefinitions,
  type OverridableSettingKey,
} from "@/domain/settings/definitions";
import type { TranslationKey } from "@/i18n";
import { reasonSchema } from "./holidays";

const msg = (key: TranslationKey) => key;
const MAX_LIST = 20;

const emailList = z.array(z.email(msg("agencies.errors.email"))).max(MAX_LIST, msg("agencies.errors.tooMany"));

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const agencyInputSchema = z
  .object({
    name: z.string().trim().min(1, msg("common.required")).max(100),
    active: z.boolean(),
    toRecipients: emailList,
    ccRecipients: emailList,
    bankSenderAliases: z
      .array(z.string().trim().min(1).max(100, msg("agencies.errors.alias")))
      .max(MAX_LIST, msg("agencies.errors.tooMany")),
    blNumberPatterns: z
      .array(z.string().trim())
      .max(MAX_LIST, msg("agencies.errors.tooMany"))
      .superRefine((patterns, ctx) => {
        patterns.forEach((pattern, index) => {
          const error = validateBlNumberPattern(pattern);
          if (error) ctx.addIssue({ code: "custom", path: [index], message: msg(`agencies.errors.pattern.${error}`) });
        });
      }),
    batchSending: z.boolean(),
    requestChannel: z.enum(REQUEST_CHANNELS),
    portalUrl: z
      .string()
      .trim()
      .max(500)
      .refine((value) => value === "" || isHttpUrl(value), msg("agencies.errors.portalUrl"))
      .transform((value) => value || null),
    notes: z
      .string()
      .trim()
      .max(2000)
      .transform((value) => value || null),
  })
  .refine((agency) => agency.requestChannel !== "PORTAL" || agency.portalUrl !== null, {
    path: ["portalUrl"],
    message: msg("agencies.errors.portalUrlRequired"),
  });

export type AgencyInput = z.infer<typeof agencyInputSchema>;

export const createAgencySchema = agencyInputSchema;
export const updateAgencySchema = z.object({ id: z.number().int().positive(), agency: agencyInputSchema });

export type AgencyOverrides = { [K in OverridableSettingKey]: number | null };

export const agencyOverridesSchema = z.object(
  Object.fromEntries(
    OVERRIDABLE_SETTING_KEYS.map((key) => [key, (settingDefinitions[key].schema as z.ZodNumber).nullable()]),
  ) as Record<OverridableSettingKey, z.ZodNullable<z.ZodNumber>>,
);

export const updateAgencyOverridesSchema = z.object({
  agencyId: z.number().int().positive(),
  overrides: agencyOverridesSchema,
  reason: reasonSchema,
});

export const setFormTemplateSchema = z.object({
  agencyId: z.number().int().positive(),
  documentId: z.number().int().positive(),
});
