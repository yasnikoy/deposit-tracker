"use server";

import { z } from "zod";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { saveCustomerFilter } from "@/server/preferences";

const customerFilterSchema = z.object({ customerIds: z.array(z.number().int().positive()).max(500) });

export async function saveCustomerFilterAction(input: unknown): Promise<ActionResult<undefined>> {
  const { user } = await requireSession();
  return runAction(customerFilterSchema, input, ({ customerIds }) => {
    saveCustomerFilter(getDb(), user, customerIds);
    return undefined;
  });
}
