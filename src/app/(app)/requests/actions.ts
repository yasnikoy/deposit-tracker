"use server";

import { ZodError } from "zod";
import {
  impactPreviewSchema,
  prepareEmailsSchema,
  queueEmailSchema,
  recordPortalRequestSchema,
  updateBlOverridesSchema,
} from "@/lib/schemas/requests";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { cancelRequestEmails, prepareRequestEmails, type EmailDraft } from "@/server/email/compose";
import { queueRequestEmail } from "@/server/email/send";
import { DomainError, type ActionResult } from "@/server/errors";
import { previewDueImpact, recordPortalRequest, updateBlOverrides, type DueImpact, type SettingsHypothesis } from "@/server/requests";

export async function recordPortalRequestAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(recordPortalRequestSchema, input, (data) => recordPortalRequest(getDb(), user, data));
}

export async function updateBlOverridesAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateBlOverridesSchema, input, (data) => updateBlOverrides(getDb(), user, data));
}

export async function previewImpactAction(input: unknown): Promise<ActionResult<DueImpact>> {
  const { user } = await requireSession();
  return runAction(impactPreviewSchema, input, (data) => {
    try {
      return previewDueImpact(getDb(), user, data as SettingsHypothesis);
    } catch (error) {
      // A value the editor has not validated yet (e.g. while typing) has no impact to show.
      if (error instanceof ZodError) throw new DomainError("settings.invalid");
      throw error;
    }
  });
}

export async function prepareEmailsAction(input: unknown): Promise<ActionResult<EmailDraft[]>> {
  const { user } = await requireSession();
  return runAction(prepareEmailsSchema, input, (data) => prepareRequestEmails(getDb(), user, data));
}

export async function cancelEmailsAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(prepareEmailsSchema, input, (data) => cancelRequestEmails(getDb(), user, data));
}

export async function queueEmailAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  return runAction(queueEmailSchema, input, (data) => queueRequestEmail(getDb(), user, data));
}
