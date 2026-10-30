"use server";

import { approveWriteOffSchema, rejectWriteOffSchema } from "@/lib/schemas/deductions";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { approveWriteOff, rejectWriteOff } from "@/server/write-offs";

export async function approveWriteOffAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(approveWriteOffSchema, input, (data) => approveWriteOff(getDb(), user, data));
}

export async function rejectWriteOffAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(rejectWriteOffSchema, input, (data) => rejectWriteOff(getDb(), user, data));
}
