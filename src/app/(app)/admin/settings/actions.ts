"use server";

import { z } from "zod";
import { reasonSchema } from "@/lib/schemas/holidays";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { updateSettings } from "@/server/settings";
import { resetEmailTemplateSchema, sendTestEmailSchema, updateEmailTemplateSchema } from "@/lib/schemas/email-settings";
import { sendTestEmail } from "@/server/email/send";
import { resetEmailTemplate, updateEmailTemplate } from "@/server/email/templates";
import { mailTransport } from "@/server/email/transport";
import { scheduleDailyBackup, scheduleWeeklySummary } from "@/server/recurring-jobs";

// Each value is validated against its own schema in the setting registry by updateSettings.
const updateSettingsSchema = z.object({
  changes: z.array(z.object({ key: z.string().max(100), value: z.unknown() })).min(1).max(50),
  reason: reasonSchema,
});

export async function updateSettingsAction(input: unknown): Promise<ActionResult<string[]>> {
  const { user } = await requireSession();
  return runAction(updateSettingsSchema, input, (data) => {
    const db = getDb();
    const changed = updateSettings(db, user, data);
    if (changed.includes("backups.dailyTime")) scheduleDailyBackup(db);
    // The pending weekly summary moves to the new weekday and time.
    if (changed.includes("notifications.weeklySummaryWeekday") || changed.includes("notifications.weeklySummaryTime")) scheduleWeeklySummary(db, new Date(), { move: true });
    return changed;
  });
}

export async function sendTestEmailAction(input: unknown): Promise<ActionResult<{ dryRun: boolean }>> {
  const { user } = await requireSession();
  return runAction(sendTestEmailSchema, input, (data) => sendTestEmail(getDb(), user, data, mailTransport(getDb())));
}

export async function updateEmailTemplateAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateEmailTemplateSchema, input, (data) => updateEmailTemplate(getDb(), user, data));
}

export async function resetEmailTemplateAction(input: unknown): Promise<ActionResult<{ subject: string; body: string }>> {
  const { user } = await requireSession();
  return runAction(resetEmailTemplateSchema, input, (data) => resetEmailTemplate(getDb(), user, data));
}
