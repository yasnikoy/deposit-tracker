import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { SETTING_KEYS } from "@/domain/settings/definitions";
import type { TranslationKey } from "@/i18n";
import { agencyOverridesSchema } from "./agencies";
import { reasonSchema } from "./holidays";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();

export const recordPortalRequestSchema = z.object({
  blId: id,
  requestedOn: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
  portalRef: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((value) => value || null),
});

export const updateBlOverridesSchema = z.object({ blId: id, overrides: agencyOverridesSchema, reason: reasonSchema });

/** Values are validated per key on the server, like a settings save. */
export const impactPreviewSchema = z
  .object({
    settings: z.partialRecord(z.enum(SETTING_KEYS as [string, ...string[]]), z.unknown()).optional(),
    agency: z.object({ agencyId: id, overrides: agencyOverridesSchema }).optional(),
    bl: z.object({ blId: id, overrides: agencyOverridesSchema }).optional(),
  })
  .refine((h) => [h.settings, h.agency, h.bl].filter(Boolean).length === 1);
