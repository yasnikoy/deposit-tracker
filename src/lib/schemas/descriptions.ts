import { z } from "zod";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;

/** The description as typed, with the text the user started from (see `updateBlDescription`). */
export const updateBlDescriptionSchema = z.object({
  blId: z.number().int().positive(),
  description: z.string().max(10_000, msg("description.errors.tooLong")),
  previous: z.string().max(10_000).nullable(),
});

/** A line added to the description of several B/Ls. */
export const appendBlDescriptionSchema = z.object({
  blIds: z.array(z.number().int().positive()).min(1).max(500),
  text: z.string().trim().min(1, msg("description.errors.empty")).max(2000),
});

export const markReadSchema = z.object({ ids: z.array(z.number().int().positive()).max(500).optional() });
