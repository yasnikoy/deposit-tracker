import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { SETTING_KEYS } from "@/domain/settings/definitions";
import type { TranslationKey } from "@/i18n";
import { agencyOverridesSchema } from "./agencies";
import { blIdsSchema } from "./bls";
import { reasonSchema } from "./holidays";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();

export const recordOutsideRequestSchema = z.object({
  blIds: blIdsSchema,
  requestedOn: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
  note: z
    .string()
    .trim()
    .max(1000)
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

const blIds = z.array(id).min(1).max(200);
const addresses = z.array(z.string().trim().toLowerCase().pipe(z.email(msg("requests.errors.recipients")))).max(50);

export const prepareEmailsSchema = z.object({ blIds });

export const queueEmailSchema = z.object({
  blIds,
  to: addresses.min(1, msg("requests.errors.recipients")),
  cc: addresses,
  bcc: addresses,
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(20_000),
  documentIds: z.array(id).max(100),
  confirmMissingEvidence: z.boolean().default(false),
  confirmPortalFiled: z.boolean().default(false),
});

/** Sending a request email again; the original is a sent request email (or one of its resends). */
export const prepareResendSchema = z.object({ emailId: id });

export const queueResendSchema = z.object({
  emailId: id,
  to: addresses.min(1, msg("requests.errors.recipients")),
  cc: addresses,
  bcc: addresses,
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(20_000),
  documentIds: z.array(id).max(100),
});
