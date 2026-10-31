"use server";

import { z } from "zod";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { runBackupNow } from "@/server/backups";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import type { ActionResult } from "@/server/errors";

/** Runs a backup right away; the result says whether the second location was written too. */
export async function runBackupNowAction(input: unknown): Promise<ActionResult<{ secondError: string | null }>> {
  const { user } = await requireSession();
  return runAction(z.object({}), input, async () => {
    const result = await runBackupNow(getDb(), user, getEnv().dataDir);
    return { secondError: result.second && "error" in result.second ? result.second.error : null };
  });
}
