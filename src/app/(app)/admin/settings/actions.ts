"use server";

import { z } from "zod";
import { reasonSchema } from "@/lib/schemas/holidays";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { updateSettings } from "@/server/settings";

// Each value is validated against its own schema in the setting registry by updateSettings.
const updateSettingsSchema = z.object({
  changes: z.array(z.object({ key: z.string().max(100), value: z.unknown() })).min(1).max(50),
  reason: reasonSchema,
});

export async function updateSettingsAction(input: unknown): Promise<ActionResult<string[]>> {
  const { user } = await requireSession();
  return runAction(updateSettingsSchema, input, (data) => updateSettings(getDb(), user, data));
}
