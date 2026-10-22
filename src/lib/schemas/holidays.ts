import { z } from "zod";
import { HOLIDAY_KINDS, isValidIsoDate } from "@/domain/business-days";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;

// Accepts its own output (null) too, so already-parsed data can be sent again.
export const reasonSchema = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((value) => value || null);

export const holidayInputSchema = z.object({
  date: z.string().refine(isValidIsoDate, msg("holidays.errors.date")),
  name: z.string().trim().min(1, msg("holidays.errors.name")).max(100),
  kind: z.enum(HOLIDAY_KINDS),
});

export const saveHolidaysSchema = z.object({
  holidays: z.array(holidayInputSchema).min(1).max(400),
  reason: reasonSchema,
});

export const updateHolidaySchema = z.object({
  id: z.number().int().positive(),
  name: holidayInputSchema.shape.name,
  kind: holidayInputSchema.shape.kind,
  reason: reasonSchema,
});

export const deleteHolidaySchema = z.object({ id: z.number().int().positive(), reason: reasonSchema });
