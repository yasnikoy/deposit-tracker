"use server";

import { createCustomerSchema, setStandingDocumentSchema, updateCustomerSchema } from "@/lib/schemas/customers";
import { deleteRecordSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { createCustomer, deleteCustomer, updateCustomer } from "@/server/customers";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { setStandingDocument } from "@/server/standing-documents";

export async function createCustomerAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  // New customers start active; deactivating is an edit.
  return runAction(createCustomerSchema, input, ({ active: _active, ...data }) => createCustomer(getDb(), user, data));
}

export async function updateCustomerAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateCustomerSchema, input, (data) => updateCustomer(getDb(), user, data));
}

export async function deleteCustomerAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(deleteRecordSchema, input, (data) => deleteCustomer(getDb(), user, data));
}

export async function setStandingDocumentAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setStandingDocumentSchema, input, (data) => setStandingDocument(getDb(), user, data));
}
