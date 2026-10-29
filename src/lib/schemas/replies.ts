import { z } from "zod";
import { isValidIsoDate } from "@/domain/business-days";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const id = z.number().int().positive();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

export const emailBlSchema = z.object({ emailId: id, blId: id });

/** One B/L, "apply to all" of an email, or a bulk action over several emails. */
export const recordEmailRepliesSchema = z.object({ items: z.array(emailBlSchema).min(1).max(500), replyTypeId: id });

export const recordReplyWithoutEmailSchema = z.object({
  blId: id,
  replyTypeId: id,
  repliedOn: z.string().refine(isValidIsoDate, msg("payments.errors.date")),
  note: optionalText(1000),
});

export const mailboxSearchSchema = z.object({ blId: id, from: z.string().trim().max(200), subject: z.string().trim().max(200) });

export const linkMailboxMessageSchema = z.object({ blId: id, uid: id, uidValidity: z.string().min(1).max(40) });
