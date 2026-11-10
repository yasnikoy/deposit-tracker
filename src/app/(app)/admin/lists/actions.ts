"use server";

import { bankAccountInputSchema, currencyInputSchema, typeInputSchema } from "@/lib/schemas/lists";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { saveBankAccount, saveCurrency, saveDeductionType, saveHoldReason, saveReplyType } from "@/server/lists";

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
  return runAction(typeInputSchema, input, (data) => saveReplyType(getDb(), user, data));
}

export async function saveDeductionTypeAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(typeInputSchema, input, (data) => saveDeductionType(getDb(), user, data));
}

export async function saveHoldReasonAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(typeInputSchema, input, (data) => saveHoldReason(getDb(), user, data));
}
