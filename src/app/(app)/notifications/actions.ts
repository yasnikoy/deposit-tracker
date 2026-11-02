"use server";

import { markReadSchema } from "@/lib/schemas/descriptions";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { markNotificationsRead } from "@/server/notifications";

export async function markReadAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(markReadSchema, input, (data) => markNotificationsRead(getDb(), user, data));
}
