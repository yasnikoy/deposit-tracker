"use server";

import { openingBalanceSchema } from "@/lib/schemas/opening-balances";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { createOpeningBalance } from "@/server/opening-balances";

export async function createOpeningBalanceAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(openingBalanceSchema, input, (data) => createOpeningBalance(getDb(), user, data));
}
