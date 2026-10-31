"use server";

import { attachEvidenceSchema, correctPaymentSchema, createPaymentSchema, discardQueueItemSchema, voidSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { attachPaymentEvidence, correctPayment, createPayment, discardQueueItem, readUploadedReceipt, voidPayment, type CreatePaymentResult } from "@/server/payments";
import { correctRefundSchema, createRefundSchema } from "@/lib/schemas/refunds";
import { correctRefund, createRefund, voidRefund, type CreateRefundResult } from "@/server/refunds";

export async function createPaymentAction(input: unknown): Promise<ActionResult<CreatePaymentResult>> {
  const { user } = await requireSession();
  return runAction(createPaymentSchema, input, async (data) => {
    const db = getDb();
    // A receipt from the bulk queue brings its reading along; a single upload is read again here.
    const extraction = data.evidenceDocumentId !== null && data.queueItemId === null ? await readUploadedReceipt(db, user, data.evidenceDocumentId) : null;
    return createPayment(db, user, { ...data, extraction });
  });
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

export async function createRefundAction(input: unknown): Promise<ActionResult<CreateRefundResult>> {
  const { user } = await requireSession();
  return runAction(createRefundSchema, input, (data) => createRefund(getDb(), user, data));
}

export async function correctRefundAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(correctRefundSchema, input, (data) => correctRefund(getDb(), user, data));
}

export async function voidRefundAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(voidSchema, input, (data) => voidRefund(getDb(), user, data));
}

export async function attachPaymentEvidenceAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(attachEvidenceSchema, input, (data) => attachPaymentEvidence(getDb(), user, data));
}
