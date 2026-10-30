import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { businessDaysBetween, istanbulToday, type IsoDate } from "@/domain/business-days";
import type { EmailLinkSource } from "@/domain/records";
import type { ReplyTypeCode } from "@/domain/replies";
import type { Role } from "@/domain/roles";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { loadCalendar } from "./calendar";
import type { Db, DbOrTx } from "./db/client";
import {
  agencies,
  billsOfLading,
  documents,
  emailAttachments,
  emailBlLinks,
  emailMatchSuggestions,
  emails,
  replies,
  replyTypes,
  requests,
  users,
} from "./db/schema";
import { importMessage, parseMessage } from "./email/inbound";
import type { Mailbox, MailboxSummary } from "./email/mailbox";
import { deductionTarget, type DeductionTarget } from "./deductions";
import { DomainError } from "./errors";
import { getSetting } from "./settings";

type EmailRow = typeof emails.$inferSelect;

export type ReplyListRow = {
  emailId: number;
  receivedAt: string;
  from: string;
  subject: string;
  agencyName: string | null;
  /** Linked B/Ls (to process, processed) or suggested ones (possible matches). */
  blNos: string[];
  /** Linked B/Ls still waiting for a reply type. */
  pending: { blId: number; blNo: string }[];
  attachments: number;
  /** Unprocessed for longer than the warning setting. */
  overdue: boolean;
};

export type ReplyLists = { TO_PROCESS: ReplyListRow[]; MATCHES: ReplyListRow[]; PROCESSED: ReplyListRow[] };

type LinkState = { emailId: number; blId: number; blNo: string; voided: boolean; replied: boolean };

/** Links of incoming emails with whether each B/L already has a reply type for that email. */
function linkStates(db: DbOrTx, emailIds?: number[]): LinkState[] {
  const links = db
    .select({ emailId: emailBlLinks.emailId, blId: emailBlLinks.blId, blNo: billsOfLading.blNo, voidedAt: billsOfLading.voidedAt })
    .from(emailBlLinks)
    .innerJoin(billsOfLading, eq(billsOfLading.id, emailBlLinks.blId))
    .where(emailIds ? inArray(emailBlLinks.emailId, emailIds) : undefined)
    .all();
  const recorded = new Set(
    db
      .select({ emailId: replies.emailId, blId: replies.blId })
      .from(replies)
      .where(isNotNull(replies.emailId))
      .all()
      .map((r) => `${r.emailId}:${r.blId}`),
  );
  return links.map((l) => ({ emailId: l.emailId, blId: l.blId, blNo: l.blNo, voided: l.voidedAt !== null, replied: recorded.has(`${l.emailId}:${l.blId}`) }));
}

/** A linked reply is processed once every active B/L it concerns has a reply type for it. */
const pendingOf = (links: LinkState[]) => links.filter((l) => !l.voided && !l.replied);

function isOverdue(db: DbOrTx, receivedAt: string, now: Date, calendar = loadCalendar(db)): boolean {
  const days = businessDaysBetween(istanbulToday(new Date(receivedAt)), istanbulToday(now), calendar);
  return days >= getSetting("durations.unprocessedReplyWarningDays", {}, db);
}

/** The Replies screen: to process, possible matches and processed, newest first. */
export function listReplies(db: DbOrTx, actor: AuthUser, now: Date = new Date()): ReplyLists {
  authorize(actor, "reply.view");
  const incoming = db
    .select({ email: emails, agencyName: agencies.name })
    .from(emails)
    .leftJoin(agencies, eq(agencies.id, emails.agencyId))
    .where(eq(emails.direction, "IN"))
    .orderBy(desc(emails.receivedAt), desc(emails.id))
    .all();
  const links = linkStates(db);
  const suggestions = db
    .select({ emailId: emailMatchSuggestions.emailId, blNo: billsOfLading.blNo })
    .from(emailMatchSuggestions)
    .innerJoin(billsOfLading, eq(billsOfLading.id, emailMatchSuggestions.blId))
    .where(eq(emailMatchSuggestions.state, "OPEN"))
    .all();
  const attachmentCounts = new Map<number, number>();
  for (const a of db.select({ emailId: emailAttachments.emailId }).from(emailAttachments).all()) {
    attachmentCounts.set(a.emailId, (attachmentCounts.get(a.emailId) ?? 0) + 1);
  }
  const calendar = loadCalendar(db);

  const lists: ReplyLists = { TO_PROCESS: [], MATCHES: [], PROCESSED: [] };
  for (const { email, agencyName } of incoming) {
    const own = links.filter((l) => l.emailId === email.id);
    const base = {
      emailId: email.id,
      receivedAt: email.receivedAt!,
      from: email.fromAddress,
      subject: email.subject,
      agencyName,
      attachments: attachmentCounts.get(email.id) ?? 0,
    };
    const suggested = suggestions.filter((s) => s.emailId === email.id).map((s) => s.blNo);
    if (suggested.length > 0) lists.MATCHES.push({ ...base, blNos: suggested, pending: [], overdue: false });
    if (own.length === 0) continue;
    const pending = pendingOf(own).map(({ blId, blNo }) => ({ blId, blNo }));
    const row = { ...base, blNos: own.map((l) => l.blNo), pending, overdue: pending.length > 0 && isOverdue(db, email.receivedAt!, now, calendar) };
    (pending.length > 0 ? lists.TO_PROCESS : lists.PROCESSED).push(row);
  }
  return lists;
}

export type UnprocessedSummary = { count: number; overdue: number; overdueByAgency: { agencyName: string; count: number }[] };

/** For the menu badge and the daily email: unprocessed linked replies, and those past the warning. */
export function unprocessedSummary(db: DbOrTx, now: Date = new Date()): UnprocessedSummary {
  const links = linkStates(db);
  const pendingIds = [...new Set(pendingOf(links).map((l) => l.emailId))];
  if (pendingIds.length === 0) return { count: 0, overdue: 0, overdueByAgency: [] };
  const rows = db
    .select({ receivedAt: emails.receivedAt, agencyName: agencies.name })
    .from(emails)
    .leftJoin(agencies, eq(agencies.id, emails.agencyId))
    .where(inArray(emails.id, pendingIds))
    .all();
  const calendar = loadCalendar(db);
  const byAgency = new Map<string, number>();
  for (const row of rows.filter((r) => isOverdue(db, r.receivedAt!, now, calendar))) {
    const name = row.agencyName ?? "—";
    byAgency.set(name, (byAgency.get(name) ?? 0) + 1);
  }
  const overdueByAgency = [...byAgency.entries()].map(([agencyName, count]) => ({ agencyName, count })).sort((a, b) => a.agencyName.localeCompare(b.agencyName, "tr"));
  return { count: rows.length, overdue: overdueByAgency.reduce((sum, a) => sum + a.count, 0), overdueByAgency };
}

export type ReplyDetail = {
  email: Pick<EmailRow, "id" | "direction" | "fromAddress" | "to" | "cc" | "subject" | "bodyText" | "receivedAt" | "rawDocumentId"> & { agencyName: string | null };
  attachments: { documentId: number; originalName: string; sizeBytes: number }[];
  links: {
    blId: number;
    blNo: string;
    status: string;
    voided: boolean;
    linkedBy: EmailLinkSource;
    reply: { typeName: string; code: ReplyTypeCode | null; repliedOn: IsoDate; byName: string } | null;
    currency: string;
    /** After a "deduction statement received" reply: the deductions that can be entered now. */
    deductionTarget: DeductionTarget | null;
  }[];
  suggestions: { blId: number; blNo: string; agencyName: string; status: string }[];
};

/** One incoming email with its attachments, linked B/Ls and open suggestions. */
export function getReplyDetail(db: DbOrTx, actor: AuthUser, emailId: number): ReplyDetail {
  authorize(actor, "reply.view");
  const found = db
    .select({ email: emails, agencyName: agencies.name })
    .from(emails)
    .leftJoin(agencies, eq(agencies.id, emails.agencyId))
    .where(and(eq(emails.id, emailId), eq(emails.direction, "IN")))
    .get();
  if (!found) throw new DomainError("errors.notFound");
  const { email, agencyName } = found;

  const attachments = db
    .select({ documentId: documents.id, originalName: documents.originalName, sizeBytes: documents.sizeBytes })
    .from(emailAttachments)
    .innerJoin(documents, eq(documents.id, emailAttachments.documentId))
    .where(eq(emailAttachments.emailId, emailId))
    .orderBy(documents.id)
    .all();
  const recorded = db
    .select({ blId: replies.blId, typeName: replyTypes.name, code: replyTypes.code, repliedOn: replies.repliedOn, byName: users.displayName })
    .from(replies)
    .innerJoin(replyTypes, eq(replyTypes.id, replies.replyTypeId))
    .innerJoin(users, eq(users.id, replies.createdBy))
    .where(eq(replies.emailId, emailId))
    .all();
  const links = db
    .select({ link: emailBlLinks, bl: billsOfLading })
    .from(emailBlLinks)
    .innerJoin(billsOfLading, eq(billsOfLading.id, emailBlLinks.blId))
    .where(eq(emailBlLinks.emailId, emailId))
    .orderBy(billsOfLading.blNo)
    .all()
    .map(({ link, bl }) => {
      const reply = recorded.find((r) => r.blId === bl.id);
      return {
        blId: bl.id,
        blNo: bl.blNo,
        status: bl.status,
        voided: bl.voidedAt !== null,
        linkedBy: link.linkedBy,
        reply: reply ? { typeName: reply.typeName, code: reply.code, repliedOn: reply.repliedOn, byName: reply.byName } : null,
        currency: bl.currency,
        deductionTarget: reply?.code === "STATEMENT_RECEIVED" ? deductionTarget(db, bl) : null,
      };
    });
  const suggestions = db
    .select({ blId: billsOfLading.id, blNo: billsOfLading.blNo, agencyName: agencies.name, status: billsOfLading.status })
    .from(emailMatchSuggestions)
    .innerJoin(billsOfLading, eq(billsOfLading.id, emailMatchSuggestions.blId))
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .where(and(eq(emailMatchSuggestions.emailId, emailId), eq(emailMatchSuggestions.state, "OPEN")))
    .all();

  return {
    email: {
      id: email.id,
      direction: email.direction,
      fromAddress: email.fromAddress,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      bodyText: email.bodyText,
      receivedAt: email.receivedAt,
      rawDocumentId: email.rawDocumentId,
      agencyName,
    },
    attachments,
    links,
    suggestions,
  };
}

type BlRow = typeof billsOfLading.$inferSelect;

function activeBl(tx: DbOrTx, blId: number): BlRow {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("replies.errors.voided", { bl: bl.blNo });
  return bl;
}

/** Links an incoming email to a B/L; the first link also gives the email its agency. */
function linkEmail(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, emailId: number, bl: BlRow, source: Exclude<EmailLinkSource, "THREAD">, now: Date) {
  const at = now.toISOString();
  const exists = tx.select().from(emailBlLinks).where(and(eq(emailBlLinks.emailId, emailId), eq(emailBlLinks.blId, bl.id))).get();
  if (!exists) tx.insert(emailBlLinks).values({ emailId, blId: bl.id, linkedBy: source, linkedByUser: actor.id, createdAt: at }).run();
  tx.update(emails).set({ agencyId: bl.agencyId }).where(and(eq(emails.id, emailId), eq(emails.direction, "IN"), isNull(emails.agencyId))).run();
  // An open suggestion for the same pair is settled by the link.
  tx.update(emailMatchSuggestions)
    .set({ state: "ACCEPTED", resolvedBy: actor.id, resolvedAt: at })
    .where(and(eq(emailMatchSuggestions.emailId, emailId), eq(emailMatchSuggestions.blId, bl.id), eq(emailMatchSuggestions.state, "OPEN")))
    .run();
  if (!exists) {
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "email.link", entityType: "bill_of_lading", entityId: bl.id, after: { emailId, source } }, now);
  }
}

/** Accepts a possible match with one click: the email is linked to that B/L (rule 6). */
export function acceptSuggestion(db: Db, actor: AuthUser, input: { emailId: number; blId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "email.link");
  db.transaction((tx) => {
    const suggestion = tx
      .select()
      .from(emailMatchSuggestions)
      .where(and(eq(emailMatchSuggestions.emailId, input.emailId), eq(emailMatchSuggestions.blId, input.blId)))
      .get();
    if (!suggestion || suggestion.state !== "OPEN") throw new DomainError("replies.errors.suggestionGone");
    linkEmail(tx, actor, roleUsed, input.emailId, activeBl(tx, input.blId), "SUGGESTION", now);
  });
}

/** A wrong match is dismissed; the email stays stored but is not linked. */
export function dismissSuggestion(db: Db, actor: AuthUser, input: { emailId: number; blId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "email.link");
  db.transaction((tx) => {
    const updated = tx
      .update(emailMatchSuggestions)
      .set({ state: "DISMISSED", resolvedBy: actor.id, resolvedAt: now.toISOString() })
      .where(and(eq(emailMatchSuggestions.emailId, input.emailId), eq(emailMatchSuggestions.blId, input.blId), eq(emailMatchSuggestions.state, "OPEN")))
      .run();
    if (updated.changes === 0) throw new DomainError("replies.errors.suggestionGone");
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "email.dismissSuggestion", entityType: "email", entityId: input.emailId, after: { blId: input.blId } }, now);
  });
}

function hasSentRequest(tx: DbOrTx, blId: number): boolean {
  return !!tx
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.blId, blId), eq(requests.sendStatus, "SENT")))
    .get();
}

/** Records one reply on a B/L and applies the lifecycle (only "not yet returned" moves it). */
function recordReply(
  tx: DbOrTx,
  actor: AuthUser,
  roleUsed: Role,
  input: { bl: BlRow; replyTypeId: number; repliedOn: IsoDate; emailId: number | null; note: string | null },
  now: Date,
): void {
  const { bl } = input;
  const type = tx.select().from(replyTypes).where(eq(replyTypes.id, input.replyTypeId)).get();
  if (!type || !type.active) throw new DomainError("replies.errors.replyType");
  if (!hasSentRequest(tx, bl.id)) throw new DomainError("replies.errors.noRequest", { bl: bl.blNo });

  let status = bl.status as StoredBlStatus;
  if (type.code === "NOT_RETURNED") {
    try {
      status = nextStatus(status, "NOT_RETURNED_REPLY");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("replies.errors.notReturnedStatus", { bl: bl.blNo });
      throw error;
    }
  }
  const at = now.toISOString();
  const reply = tx
    .insert(replies)
    .values({
      blId: bl.id,
      replyTypeId: type.id,
      repliedOn: input.repliedOn,
      emailId: input.emailId,
      note: input.note,
      createdBy: actor.id,
      roleUsed,
      createdAt: at,
    })
    .returning()
    .get();
  if (status !== bl.status) tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
  writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: "reply.record",
      entityType: "bill_of_lading",
      entityId: bl.id,
      before: { status: bl.status },
      after: { status, replyId: reply.id, replyType: type.name, repliedOn: input.repliedOn, emailId: input.emailId },
      reason: input.note,
    },
    now,
  );
}

/**
 * Records a reply type for linked B/Ls of incoming emails: one B/L, "apply to all" of an
 * email, or a bulk action over several emails. All or nothing; the reply date is the day the
 * email arrived.
 */
export function recordEmailReplies(
  db: Db,
  actor: AuthUser,
  input: { items: { emailId: number; blId: number }[]; replyTypeId: number },
  now: Date = new Date(),
): number {
  const roleUsed = authorize(actor, "reply.record")!;
  return db.transaction((tx) => {
    const seen = new Set<string>();
    for (const item of input.items) {
      const key = `${item.emailId}:${item.blId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = tx.select().from(emailBlLinks).where(and(eq(emailBlLinks.emailId, item.emailId), eq(emailBlLinks.blId, item.blId))).get();
      if (!link) throw new DomainError("replies.errors.notLinked");
      const bl = activeBl(tx, item.blId);
      const done = tx.select({ id: replies.id }).from(replies).where(and(eq(replies.emailId, item.emailId), eq(replies.blId, item.blId))).get();
      if (done) throw new DomainError("replies.errors.alreadyRecorded", { bl: bl.blNo });
      const email = tx.select({ receivedAt: emails.receivedAt }).from(emails).where(eq(emails.id, item.emailId)).get()!;
      recordReply(tx, actor, roleUsed, { bl, replyTypeId: input.replyTypeId, repliedOn: istanbulToday(new Date(email.receivedAt!)), emailId: item.emailId, note: null }, now);
    }
    return seen.size;
  });
}

/** A reply that did not come by email, e.g. read on the agency portal; it counts like one. */
export function recordReplyWithoutEmail(
  db: Db,
  actor: AuthUser,
  input: { blId: number; replyTypeId: number; repliedOn: IsoDate; note: string | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "reply.record")!;
  db.transaction((tx) => {
    const bl = activeBl(tx, input.blId);
    if (input.repliedOn > istanbulToday(now)) throw new DomainError("replies.errors.futureDate");
    if (input.repliedOn < bl.paidAt) throw new DomainError("replies.errors.beforePayment");
    recordReply(tx, actor, roleUsed, { bl, replyTypeId: input.replyTypeId, repliedOn: input.repliedOn, emailId: null, note: input.note }, now);
  });
}

export type MailboxSearchResult = MailboxSummary & { emailId: number | null; linked: boolean };

/** Manual link, step 1: search the shared mailbox by sender and subject from the B/L detail. */
export async function searchMailboxForBl(
  db: Db,
  actor: AuthUser,
  mailbox: Mailbox | null,
  input: { blId: number; from: string; subject: string },
): Promise<{ uidValidity: string; results: MailboxSearchResult[] }> {
  authorize(actor, "email.link");
  if (!mailbox) throw new DomainError("replies.errors.noMailbox");
  activeBl(db, input.blId);
  const { uidValidity, results } = await mailbox.search({ from: input.from.trim(), subject: input.subject.trim() }, 50);
  const ids = results.map((r) => r.messageId).filter((id): id is string => !!id);
  const stored = ids.length ? db.select({ id: emails.id, messageId: emails.messageId }).from(emails).where(inArray(emails.messageId, ids)).all() : [];
  const linked = new Set(
    stored.length
      ? db
          .select({ emailId: emailBlLinks.emailId })
          .from(emailBlLinks)
          .where(and(eq(emailBlLinks.blId, input.blId), inArray(emailBlLinks.emailId, stored.map((s) => s.id))))
          .all()
          .map((l) => l.emailId)
      : [],
  );
  return {
    uidValidity,
    results: results.map((r) => {
      const emailId = stored.find((s) => s.messageId === r.messageId)?.id ?? null;
      return { ...r, emailId, linked: emailId !== null && linked.has(emailId) };
    }),
  };
}

/**
 * Manual link, step 2: the chosen message is imported (if it is not stored yet) and linked to
 * the B/L. Its later replies are then imported automatically, as in any known thread.
 */
export async function linkMailboxMessage(
  db: Db,
  actor: AuthUser,
  mailbox: Mailbox | null,
  input: { blId: number; uid: number; uidValidity: string },
  now: Date = new Date(),
): Promise<number> {
  const roleUsed = authorize(actor, "email.link");
  if (!mailbox) throw new DomainError("replies.errors.noMailbox");
  const message = await mailbox.fetch(input.uid, input.uidValidity);
  if (!message) throw new DomainError("replies.errors.messageGone");
  const parsed = await parseMessage(message.raw);
  return db.transaction((tx) => {
    const bl = activeBl(tx, input.blId);
    const result = importMessage(tx, parsed, message, { keep: true }, now)!;
    const email = tx.select({ direction: emails.direction }).from(emails).where(eq(emails.id, result.emailId)).get()!;
    // Our own sent emails already belong to their B/Ls through their requests.
    if (email.direction !== "IN") throw new DomainError("replies.errors.ownEmail");
    linkEmail(tx, actor, roleUsed, result.emailId, bl, "MANUAL", now);
    return result.emailId;
  });
}
