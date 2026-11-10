"use server";

import { blSearchSchema, createBlsSchema, generateFormSchema, previewTransferSchema, reverseTransferSchema, setBlCustomerSchema, setBlUnitSchema, transferDepositSchema, updateBlSchema, uploadFormSchema } from "@/lib/schemas/bls";
import { classifyDeductionSchema, disputeDeductionSchema, proposeWriteOffSchema, recordStatementDeductionsSchema } from "@/lib/schemas/deductions";
import { appendBlDescriptionSchema, updateBlDescriptionSchema } from "@/lib/schemas/descriptions";
import { voidSchema } from "@/lib/schemas/payments";
import { recordReplyWithoutEmailSchema } from "@/lib/schemas/replies";
import { z } from "zod";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { searchBls, type BlSearchResult } from "@/server/bl-overview";
import { createBls, setBlCustomer, setBlUnit, updateBl, voidBl, type CreateBlsResult } from "@/server/bls";
import { getDb } from "@/server/db/client";
import { classifyDeduction, disputeDeduction, recordStatementDeductions } from "@/server/deductions";
import type { ActionResult } from "@/server/errors";
import { generateBlForm, uploadBlForm, type GeneratedForm } from "@/server/forms";
import { appendBlDescription, updateBlDescription } from "@/server/bl-description";
import { getEmailDetail, recordReplyWithoutEmail, type EmailDetail } from "@/server/replies";
import { proposeWriteOff } from "@/server/write-offs";
import { previewTransfer, reverseTransfer, transferDeposit, type TransferPreview } from "@/server/transfers";

/** Each row is validated by createBls with the shared row schema; invalid rows come back with errors. */
export async function createBlsAction(input: unknown): Promise<ActionResult<CreateBlsResult>> {
  const { user } = await requireSession();
  return runAction(createBlsSchema, input, (data) => createBls(getDb(), user, data.rows));
}

export async function updateBlAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(updateBlSchema, input, (data) => updateBl(getDb(), user, data));
}

export async function setBlCustomerAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setBlCustomerSchema, input, (data) => setBlCustomer(getDb(), user, data));
}

export async function previewTransferAction(input: unknown): Promise<ActionResult<TransferPreview>> {
  const { user } = await requireSession();
  return runAction(previewTransferSchema, input, (data) => previewTransfer(getDb(), user, data));
}

export async function transferDepositAction(input: unknown): Promise<ActionResult<{ targets: { blId: number; blNo: string; created: boolean }[] }>> {
  const { user } = await requireSession();
  return runAction(transferDepositSchema, input, (data) => transferDeposit(getDb(), user, data));
}

export async function reverseTransferAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(reverseTransferSchema, input, (data) => reverseTransfer(getDb(), user, data));
}

export async function setBlUnitAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setBlUnitSchema, input, (data) => setBlUnit(getDb(), user, data));
}

export async function voidBlAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(voidSchema, input, (data) => voidBl(getDb(), user, data));
}

export async function searchBlsAction(input: unknown): Promise<ActionResult<BlSearchResult>> {
  const { user } = await requireSession();
  return runAction(blSearchSchema, input, (data) => searchBls(getDb(), user, data.query));
}

export async function generateBlFormAction(input: unknown): Promise<ActionResult<GeneratedForm>> {
  const { user } = await requireSession();
  return runAction(generateFormSchema, input, (data) => generateBlForm(getDb(), user, data));
}

export async function uploadBlFormAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(uploadFormSchema, input, (data) => uploadBlForm(getDb(), user, data));
}

export async function recordStatementDeductionsAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(recordStatementDeductionsSchema, input, (data) => recordStatementDeductions(getDb(), user, data));
}

export async function classifyDeductionAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(classifyDeductionSchema, input, (data) => classifyDeduction(getDb(), user, data));
}

export async function disputeDeductionAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(disputeDeductionSchema, input, (data) => disputeDeduction(getDb(), user, data));
}

export async function proposeWriteOffAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(proposeWriteOffSchema, input, (data) => proposeWriteOff(getDb(), user, data));
}

export async function updateBlDescriptionAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateBlDescriptionSchema, input, (data) => updateBlDescription(getDb(), user, data));
}

export async function appendBlDescriptionAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(appendBlDescriptionSchema, input, (data) => appendBlDescription(getDb(), user, data));
}

export async function emailDetailAction(input: unknown): Promise<ActionResult<EmailDetail>> {
  const { user } = await requireSession();
  return runAction(z.object({ emailId: z.number().int().positive() }), input, (data) => getEmailDetail(getDb(), user, data.emailId));
}

/** A reply read by email, phone or on the agency portal, recorded on the B/L; it counts the same. */
export async function recordReplyWithoutEmailAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(recordReplyWithoutEmailSchema, input, (data) => recordReplyWithoutEmail(getDb(), user, data));
}
