import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import type { TranslationKey } from "@/i18n";
import { blIdsSchema } from "./bls";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();

export const recordReplyWithoutEmailSchema = z.object({
  blIds: blIdsSchema,
  replyTypeId: id,
  repliedOn: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
  note: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .transform((value) => value || null),
});
