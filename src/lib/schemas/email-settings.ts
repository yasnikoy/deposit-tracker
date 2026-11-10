import { z } from "zod";
import { EMAIL_TEMPLATE_KEYS } from "@/domain/email-templates";
import { reasonSchema } from "./holidays";

export const sendTestEmailSchema = z.object({ to: z.string().trim().toLowerCase().pipe(z.email()) });

export const resetEmailTemplateSchema = z.object({ key: z.enum(EMAIL_TEMPLATE_KEYS), reason: reasonSchema });

export const updateEmailTemplateSchema = z.object({
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  // The batch line has no subject.
  subject: z.string().trim().max(500),
  body: z.string().min(1).max(20_000),
  reason: reasonSchema,
});

