"use server";

import {
  emailBlSchema,
  linkMailboxMessageSchema,
  mailboxSearchSchema,
  recordEmailRepliesSchema,
  recordReplyWithoutEmailSchema,
} from "@/lib/schemas/replies";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { mailboxFromSettings } from "@/server/email/mailbox";
import type { ActionResult } from "@/server/errors";
import {
  acceptSuggestion,
  dismissSuggestion,
  getReplyDetail,
  linkMailboxMessage,
  recordEmailReplies,
  recordReplyWithoutEmail,
  searchMailboxForBl,
  type MailboxSearchResult,
  type ReplyDetail,
} from "@/server/replies";
import { z } from "zod";

export async function replyDetailAction(input: unknown): Promise<ActionResult<ReplyDetail>> {
  const { user } = await requireSession();
  return runAction(z.object({ emailId: z.number().int().positive() }), input, (data) => getReplyDetail(getDb(), user, data.emailId));
}

export async function recordEmailRepliesAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(recordEmailRepliesSchema, input, (data) => recordEmailReplies(getDb(), user, data));
}

export async function recordReplyWithoutEmailAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(recordReplyWithoutEmailSchema, input, (data) => recordReplyWithoutEmail(getDb(), user, data));
}

export async function acceptSuggestionAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(emailBlSchema, input, (data) => acceptSuggestion(getDb(), user, data));
}

export async function dismissSuggestionAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(emailBlSchema, input, (data) => dismissSuggestion(getDb(), user, data));
}

export async function searchMailboxAction(input: unknown): Promise<ActionResult<{ uidValidity: string; results: MailboxSearchResult[] }>> {
  const { user } = await requireSession();
  return runAction(mailboxSearchSchema, input, (data) => {
    const db = getDb();
    return searchMailboxForBl(db, user, mailboxFromSettings(db), data);
  });
}

export async function linkMailboxMessageAction(input: unknown): Promise<ActionResult<number[]>> {
  const { user } = await requireSession();
  return runAction(linkMailboxMessageSchema, input, (data) => {
    const db = getDb();
    return linkMailboxMessage(db, user, mailboxFromSettings(db), data);
  });
}
