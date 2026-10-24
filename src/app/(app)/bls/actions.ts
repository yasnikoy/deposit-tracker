"use server";

import { blSearchSchema, createBlsSchema, updateBlSchema } from "@/lib/schemas/bls";
import { voidSchema } from "@/lib/schemas/payments";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { searchBls, type BlSearchResult } from "@/server/bl-overview";
import { createBls, updateBl, voidBl, type CreateBlsResult } from "@/server/bls";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";

/** Each row is validated by createBls with the shared row schema; invalid rows come back with errors. */
export async function createBlsAction(input: unknown): Promise<ActionResult<CreateBlsResult>> {
  const { user } = await requireSession();
  return runAction(createBlsSchema, input, (data) => createBls(getDb(), user, data.rows));
}

export async function updateBlAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateBlSchema, input, (data) => updateBl(getDb(), user, data));
}

export async function voidBlAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(voidSchema, input, (data) => voidBl(getDb(), user, data));
}

export async function searchBlsAction(input: unknown): Promise<ActionResult<BlSearchResult>> {
  const { user } = await requireSession();
  return runAction(blSearchSchema, input, (data) => searchBls(getDb(), user, data.query));
}
