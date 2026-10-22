"use server";

import { saveTableLayoutSchema } from "@/lib/schemas/table-layout";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { saveTableLayout } from "@/server/preferences";

export async function saveTableLayoutAction(input: unknown): Promise<ActionResult<undefined>> {
  const { user } = await requireSession();
  return runAction(saveTableLayoutSchema, input, ({ tableId, layout }) => {
    saveTableLayout(getDb(), user, tableId, layout);
    return undefined;
  });
}
