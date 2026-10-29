"use server";

import { confirmAllocationSchema, reverseAllocationSchema } from "@/lib/schemas/refunds";
import { runAction } from "@/server/actions";
import { confirmAllocation, reverseAllocation } from "@/server/allocations";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";

export async function confirmAllocationAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(confirmAllocationSchema, input, (data) => confirmAllocation(getDb(), user, data));
}

export async function reverseAllocationAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(reverseAllocationSchema, input, (data) => reverseAllocation(getDb(), user, data));
}
