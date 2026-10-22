"use server";

import { deleteHolidaySchema, saveHolidaysSchema, updateHolidaySchema } from "@/lib/schemas/holidays";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { deleteHoliday, saveHolidays, updateHoliday } from "@/server/holidays";

export async function saveHolidaysAction(input: unknown): Promise<ActionResult<{ created: number; updated: number }>> {
  const { user } = await requireSession();
  return runAction(saveHolidaysSchema, input, (data) => saveHolidays(getDb(), user, data));
}

export async function updateHolidayAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateHolidaySchema, input, (data) => updateHoliday(getDb(), user, data));
}

export async function deleteHolidayAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(deleteHolidaySchema, input, (data) => deleteHoliday(getDb(), user, data));
}
