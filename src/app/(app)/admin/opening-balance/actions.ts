"use server";

import { attachOpeningBalanceEvidenceSchema, openingBalanceSchema } from "@/lib/schemas/opening-balances";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { attachOpeningBalanceEvidence, createOpeningBalance } from "@/server/opening-balances";

export async function createOpeningBalanceAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(openingBalanceSchema, input, (data) => createOpeningBalance(getDb(), user, data));
}

export async function attachOpeningBalanceEvidenceAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(attachOpeningBalanceEvidenceSchema, input, (data) => attachOpeningBalanceEvidence(getDb(), user, data));
}
