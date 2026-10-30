"use server";

import { z } from "zod";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { undoActions } from "@/server/undo";

const undoSchema = z.object({ auditIds: z.array(z.number().int().positive()).min(1).max(200) });

export async function undoAction(input: unknown): Promise<ActionResult<undefined>> {
  const { user } = await requireSession();
  return runAction(undoSchema, input, (data) => {
    undoActions(getDb(), user, data);
    return undefined;
  });
}
