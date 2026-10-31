"use server";

import { queueReportSchema, reportRequestSchema } from "@/lib/schemas/reports";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { queueReportEmail, reportEmailDraft, type ReportDraft } from "@/server/report-email";

export async function reportDraftAction(input: unknown): Promise<ActionResult<ReportDraft>> {
  const { user } = await requireSession();
  return runAction(reportRequestSchema, input, (data) => reportEmailDraft(getDb(), user, data));
}

export async function queueReportAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(queueReportSchema, input, (data) => queueReportEmail(getDb(), user, data));
}
