"use server";

import { bankAccountInputSchema, currencyInputSchema, replyTypeInputSchema } from "@/lib/schemas/lists";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { saveBankAccount, saveCurrency, saveReplyType } from "@/server/lists";

export async function saveCurrencyAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(currencyInputSchema, input, (data) => saveCurrency(getDb(), user, data));
}

export async function saveBankAccountAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(bankAccountInputSchema, input, (data) => saveBankAccount(getDb(), user, data));
}

export async function saveReplyTypeAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(replyTypeInputSchema, input, (data) => saveReplyType(getDb(), user, data));
}
