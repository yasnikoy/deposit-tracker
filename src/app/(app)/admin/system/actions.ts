"use server";

import { z } from "zod";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { authorize } from "@/server/auth/can";
import { runBackupNow } from "@/server/backups";
import { checkForUpdate, restartForUpdate, stageUpdate } from "@/server/updates";
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

/** "Şimdi kontrol et": asks GitHub for the latest release now. */
export async function checkUpdatesAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(z.object({}), input, async () => {
    authorize(user, "system.view");
    await checkForUpdate();
  });
}

/** "Güncelle": downloads and verifies the update, then restarts the app so it is installed. */
export async function installUpdateAction(input: unknown): Promise<ActionResult<{ version: string }>> {
  const { user } = await requireSession();
  return runAction(z.object({}), input, async () => {
    const version = await stageUpdate(getDb(), user);
    restartForUpdate();
    return { version };
  });
}
