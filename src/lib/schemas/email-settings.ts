import { z } from "zod";
import { EMAIL_TEMPLATE_KEYS } from "@/domain/email-templates";
import { STANDING_DOCUMENT_SLOTS } from "@/domain/records";
import { reasonSchema } from "./holidays";

export const sendTestEmailSchema = z.object({ to: z.string().trim().toLowerCase().pipe(z.email()) });

export const updateEmailTemplateSchema = z.object({
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  // The batch line has no subject.
  subject: z.string().trim().max(500),
  body: z.string().min(1).max(20_000),
  reason: reasonSchema,
});

export const setStandingDocumentSchema = z.object({
  slot: z.enum(STANDING_DOCUMENT_SLOTS),
  documentId: z.number().int().positive(),
});
