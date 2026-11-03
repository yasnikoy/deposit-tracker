import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import { REPORT_SECTIONS } from "@/domain/report-email";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const isoDate = z.string().refine(isValidIsoDate, msg("reports.email.errors.period"));
const addresses = z.array(z.string().trim().toLowerCase().pipe(z.email(msg("reports.email.errors.recipients")))).max(50);

export const reportRequestSchema = z.object({
  sections: z
    .array(z.enum(REPORT_SECTIONS))
    .max(REPORT_SECTIONS.length)
    .transform((sections) => [...new Set(sections)]),
  filters: z.object({
    agencyIds: z.array(z.number().int().positive()).max(500),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    // The period of the requested section (requests sent then); required when it is chosen.
    requestedFrom: isoDate.nullable().default(null),
    requestedTo: isoDate.nullable().default(null),
    collectedFrom: isoDate.nullable(),
    collectedTo: isoDate.nullable(),
    // The period of the transferred section (by transfer date); required when it is chosen.
    transferredFrom: isoDate.nullable().default(null),
    transferredTo: isoDate.nullable().default(null),
  }),
});

export const queueReportSchema = reportRequestSchema.extend({
  to: addresses.min(1, msg("reports.email.errors.recipients")),
  cc: addresses,
  subject: z.string().trim().min(1).max(500),
  intro: z.string().max(20_000),
});
