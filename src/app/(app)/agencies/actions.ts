"use server";

import { createAgencySchema, importAgenciesSchema, setFormTemplateSchema, updateAgencyContactSchema, updateAgencyOverridesSchema, updateAgencySchema } from "@/lib/schemas/agencies";
import { deleteRecordSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { createAgency, deleteAgency, importAgencies, updateAgency, updateAgencyContact, updateAgencyOverrides } from "@/server/agencies";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { setAgencyFormTemplate } from "@/server/forms";

export async function createAgencyAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(createAgencySchema, input, (data) => createAgency(getDb(), user, data));
}

export async function importAgenciesAction(input: unknown): Promise<ActionResult<{ created: string[]; skipped: string[] }>> {
  const { user } = await requireSession();
  return runAction(importAgenciesSchema, input, (data) => importAgencies(getDb(), user, data));
}

export async function updateAgencyAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(updateAgencySchema, input, (data) => updateAgency(getDb(), user, data));
}

export async function updateAgencyContactAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(updateAgencyContactSchema, input, (data) => updateAgencyContact(getDb(), user, data));
}

export async function updateAgencyOverridesAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateAgencyOverridesSchema, input, (data) => updateAgencyOverrides(getDb(), user, data));
}

export async function setAgencyFormTemplateAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setFormTemplateSchema, input, (data) => setAgencyFormTemplate(getDb(), user, data));
}

export async function deleteAgencyAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(deleteRecordSchema, input, (data) => deleteAgency(getDb(), user, data));
}
