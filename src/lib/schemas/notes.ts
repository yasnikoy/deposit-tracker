import { z } from "zod";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;

export const addNotesSchema = z.object({
  blIds: z.array(z.number().int().positive()).min(1).max(500),
  body: z.string().trim().min(1, msg("notes.errors.empty")).max(5000),
});

export const markReadSchema = z.object({ ids: z.array(z.number().int().positive()).max(500).optional() });
