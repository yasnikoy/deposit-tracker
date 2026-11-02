"use server";

import { z } from "zod";
import { attachEvidenceSchema, correctPaymentSchema, createPaymentSchema, discardQueueItemSchema, previewBlJoinSchema, voidSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { recordAccountingEntry } from "@/server/bls";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import {
  attachPaymentEvidence,
  correctPayment,
  createPayment,
  discardQueueItem,
  previewBlJoin,
  readUploadedReceipt,
  voidPayment,
  type BlJoinPreview,
  type CreatePaymentResult,
} from "@/server/payments";
import { attachRefundEvidenceSchema, correctRefundSchema, createRefundSchema } from "@/lib/schemas/refunds";
import { attachRefundEvidence, correctRefund, createRefund, voidRefund, type CreateRefundResult } from "@/server/refunds";

export async function createPaymentAction(input: unknown): Promise<ActionResult<CreatePaymentResult>> {
  const { user } = await requireSession();
  return runAction(createPaymentSchema, input, async (data) => {
    const db = getDb();
    // A receipt from the bulk queue brings its reading along; a single upload is read again here.
    const extraction = data.evidenceDocumentId !== null && data.queueItemId === null ? await readUploadedReceipt(db, user, data.evidenceDocumentId) : null;
    return createPayment(db, user, { ...data, extraction });
  });
}

/** Payment and opening-balance forms: whether the typed B/L number adds to an existing B/L. */
export async function previewBlJoinAction(input: unknown): Promise<ActionResult<BlJoinPreview | null>> {
  const { user } = await requireSession();
  return runAction(previewBlJoinSchema, input, (data) => previewBlJoin(getDb(), user, data));
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

export async function attachRefundEvidenceAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(attachRefundEvidenceSchema, input, (data) => attachRefundEvidence(getDb(), user, data));
}

const accountingEntrySchema = z.object({ blIds: z.array(z.number().int().positive()).min(1).max(200) });

export async function recordAccountingEntryAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(accountingEntrySchema, input, (data) => recordAccountingEntry(getDb(), user, data));
}
