"use server";

import { correctPaymentSchema, createPaymentSchema, discardQueueItemSchema, voidSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { correctPayment, createPayment, discardQueueItem, voidPayment, type CreatePaymentResult } from "@/server/payments";

export async function createPaymentAction(input: unknown): Promise<ActionResult<CreatePaymentResult>> {
  const { user } = await requireSession();
  return runAction(createPaymentSchema, input, (data) => createPayment(getDb(), user, data));
}

export async function correctPaymentAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(correctPaymentSchema, input, (data) => correctPayment(getDb(), user, data));
}

export async function voidPaymentAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(voidSchema, input, (data) => voidPayment(getDb(), user, data));
}

export async function discardQueueItemAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(discardQueueItemSchema, input, (data) => discardQueueItem(getDb(), user, data));
}
