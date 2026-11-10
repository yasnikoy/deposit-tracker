import { z } from "zod";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;

export const submitFeedbackSchema = z.object({
  kind: z.enum(["BUG", "IDEA"]),
  body: z.string().trim().min(1, msg("feedback.errors.body")).max(4000),
  page: z.string().max(500).nullable(),
});

export const setFeedbackClosedSchema = z.object({ id: z.number().int().positive(), closed: z.boolean() });
