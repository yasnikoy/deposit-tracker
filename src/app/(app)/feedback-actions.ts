"use server";

import { setFeedbackClosedSchema, submitFeedbackSchema } from "@/lib/schemas/feedback";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import { setFeedbackClosed, submitFeedback } from "@/server/feedback";

export async function submitFeedbackAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(submitFeedbackSchema, input, (data) => submitFeedback(getDb(), user, data));
}

export async function setFeedbackClosedAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setFeedbackClosedSchema, input, (data) => setFeedbackClosed(getDb(), user, data));
}
