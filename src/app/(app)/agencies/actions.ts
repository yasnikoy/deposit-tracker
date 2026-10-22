"use server";

import { createAgencySchema, updateAgencyOverridesSchema, updateAgencySchema } from "@/lib/schemas/agencies";
import { runAction } from "@/server/actions";
import { createAgency, updateAgency, updateAgencyOverrides } from "@/server/agencies";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";

export async function createAgencyAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(createAgencySchema, input, (data) => createAgency(getDb(), user, data));
}

export async function updateAgencyAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateAgencySchema, input, (data) => updateAgency(getDb(), user, data));
}

export async function updateAgencyOverridesAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateAgencyOverridesSchema, input, (data) => updateAgencyOverrides(getDb(), user, data));
}
