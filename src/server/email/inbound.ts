import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { findBlNumbers } from "@/domain/replies";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { billsOfLading, emailAttachments, emailBlLinks, emailMatchSuggestions, emails, mailboxState, requests } from "../db/schema";
import { storeImportedDocument } from "../files";
import type { JobHandler } from "../jobs";
import { logger } from "../logger";
import { markServiceFailing, markServiceOk } from "../service-status";
import { getSetting } from "../settings";
import type { Mailbox, MailboxMessage } from "./mailbox";

/** Messages read per mailbox session; a longer backlog continues in the next session right away. */
const POLL_BATCH = 50;

export type ParsedMessage = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
};

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => a.value.map((v) => v.address ?? "")).filter(Boolean);

const messageIds = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value ? value.split(/\s+/) : []).map((id) => id.trim()).filter(Boolean);

/** Crude text of an HTML-only message; the app shows replies as plain text, never as HTML. */
const htmlToText = (html: string) =>
  html
    .replace(/<(br|\/p|\/div|\/tr)\s*\/?>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const mail: ParsedMail = await simpleParser(raw, { skipImageLinks: true });
  const text = mail.text?.trim() || (typeof mail.html === "string" ? htmlToText(mail.html) : "");
  return {
    // A message without a Message-ID gets a stable one, so it is still imported only once.
    messageId: mail.messageId ?? `<imported-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}@deposit.invalid>`,
    inReplyTo: messageIds(mail.inReplyTo)[0] ?? null,
    references: messageIds(mail.references),
    from: mail.from?.value[0]?.address?.toLowerCase() ?? "",
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject ?? "",
    text,
    attachments: mail.attachments
      // Inline images (signature logos) belong to the message body, not to the B/L.
      .filter((a) => !a.related)
      .map((a, i) => ({ filename: a.filename || `ek-${i + 1}`, content: a.content, contentType: a.contentType || "application/octet-stream" })),
  };
}

/** The active B/Ls a stored message belongs to: requests of a sent email, links of an imported one. */
function blsOfEmails(tx: DbOrTx, emailIds: number[]): number[] {
  if (emailIds.length === 0) return [];
  const fromRequests = tx.select({ blId: requests.blId }).from(requests).where(inArray(requests.emailId, emailIds)).all();
  const fromLinks = tx.select({ blId: emailBlLinks.blId }).from(emailBlLinks).where(inArray(emailBlLinks.emailId, emailIds)).all();
  const ids = [...new Set([...fromRequests, ...fromLinks].map((r) => r.blId))];
  if (ids.length === 0) return [];
  return tx
    .select({ id: billsOfLading.id })
    .from(billsOfLading)
    .where(and(inArray(billsOfLading.id, ids), isNull(billsOfLading.voidedAt)))
    .all()
    .map((r) => r.id);
}

/** Open B/Ls whose number occurs in the message, for "possible matches". */
function mentionedOpenBls(tx: DbOrTx, message: ParsedMessage): { id: number; agencyId: number }[] {
  const open = tx
    .select({ id: billsOfLading.id, blNo: billsOfLading.blNo, agencyId: billsOfLading.agencyId })
    .from(billsOfLading)
    .where(and(isNull(billsOfLading.voidedAt), ne(billsOfLading.status, "COLLECTED")))
    .all();
  const found = new Set(findBlNumbers(`${message.subject}\n${message.text}`, open.map((bl) => bl.blNo)));
  return open.filter((bl) => found.has(bl.blNo));
}

export type ImportResult = { emailId: number; created: boolean } | null;

/**
 * Imports one message from the mailbox, inside the caller's transaction. A reply in a known
 * thread (In-Reply-To / References pointing to a stored message) is linked to that message's
 * B/Ls with certainty; a message naming open B/Ls becomes a possible match; anything else is
 * ignored unless `keep` is set (a user links it by hand). Already stored messages are not
 * imported again.
 */
export function importMessage(
  tx: DbOrTx,
  message: ParsedMessage,
  source: { raw: Buffer; receivedAt: Date },
  options: { keep?: boolean } = {},
  now: Date = new Date(),
): ImportResult {
  const existing = tx.select({ id: emails.id }).from(emails).where(eq(emails.messageId, message.messageId)).get();
  if (existing) return { emailId: existing.id, created: false };
  const ownAddress = getSetting("email.fromAddress", {}, tx);
  if (!options.keep && ownAddress && message.from === ownAddress.toLowerCase()) return null;

  const referenced = [...new Set([message.inReplyTo, ...message.references].filter((id): id is string => !!id))];
  const known = referenced.length
    ? tx.select({ id: emails.id, agencyId: emails.agencyId }).from(emails).where(inArray(emails.messageId, referenced)).all()
    : [];
  const threadBls = blsOfEmails(
    tx,
    known.map((e) => e.id),
  );
  const mentioned = mentionedOpenBls(tx, message).filter((bl) => !threadBls.includes(bl.id));
  if (threadBls.length === 0 && mentioned.length === 0 && !options.keep) return null;

  const at = now.toISOString();
  const agencyId =
    known.find((e) => e.agencyId !== null)?.agencyId ??
    (threadBls.length ? tx.select({ agencyId: billsOfLading.agencyId }).from(billsOfLading).where(eq(billsOfLading.id, threadBls[0])).get()!.agencyId : null);
  const email = tx
    .insert(emails)
    .values({
      direction: "IN",
      agencyId,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
      fromAddress: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      bodyText: message.text,
      receivedAt: source.receivedAt.toISOString(),
      createdAt: at,
    })
    .returning()
    .get();
  const raw = storeImportedDocument(
    tx,
    { originalName: `e-posta-${email.id}.eml`, content: source.raw, mimeType: "message/rfc822", ownerType: "email", ownerId: email.id },
    now,
  );
  tx.update(emails).set({ rawDocumentId: raw.id }).where(eq(emails.id, email.id)).run();
  for (const attachment of message.attachments) {
    if (attachment.content.length === 0) continue;
    const doc = storeImportedDocument(
      tx,
      { originalName: attachment.filename, content: attachment.content, mimeType: attachment.contentType, ownerType: "email", ownerId: email.id },
      now,
    );
    tx.insert(emailAttachments).values({ emailId: email.id, documentId: doc.id }).run();
  }

  for (const blId of threadBls) {
    tx.insert(emailBlLinks).values({ emailId: email.id, blId, linkedBy: "THREAD", linkedByUser: null, createdAt: at }).run();
    writeAudit(
      tx,
      { actorUserId: null, roleUsed: null, action: "email.received", entityType: "bill_of_lading", entityId: blId, after: { emailId: email.id, subject: message.subject, from: message.from } },
      now,
    );
  }
  for (const bl of mentioned) {
    tx.insert(emailMatchSuggestions).values({ emailId: email.id, blId: bl.id, createdAt: at }).run();
  }
  return { emailId: email.id, created: true };
}

/** Where the first poll starts: the first request the app recorded (nothing before can be a reply). */
function firstPollSince(db: DbOrTx, now: Date): Date {
  const first = db
    .select({ sentAt: requests.sentAt })
    .from(requests)
    .where(isNotNull(requests.sentAt))
    .orderBy(asc(requests.sentAt))
    .get();
  const since = new Date(first?.sentAt ?? now.toISOString());
  // IMAP SINCE compares dates only; start a day early so no reply of that day is missed.
  return new Date(since.getTime() - 24 * 60 * 60 * 1000);
}

/** Imports one polled message and moves the cursor past it; true when a new email was stored. */
async function importOne(db: Db, mailbox: Mailbox, message: MailboxMessage, uidValidity: string, now: Date): Promise<boolean> {
  let parsed: ParsedMessage | null = null;
  try {
    parsed = await parseMessage(message.raw);
  } catch (error) {
    // An unreadable message is skipped (and logged); it must not block the rest of the mailbox.
    logger.warn({ err: error, uid: message.uid }, "mailbox message could not be parsed");
  }
  return db.transaction((tx) => {
    const result = parsed ? importMessage(tx, parsed, message, {}, now) : null;
    if (result?.created) logger.info({ emailId: result.emailId, uid: message.uid }, "agency email imported");
    saveCursor(tx, mailbox.folder, { uidValidity, lastUid: message.uid }, now);
    return result?.created ?? false;
  });
}

function saveCursor(tx: DbOrTx, folder: string, cursor: { uidValidity: string; lastUid: number }, now: Date): void {
  const at = now.toISOString();
  tx.insert(mailboxState)
    .values({ folder, uidValidity: cursor.uidValidity, lastUid: cursor.lastUid, lastPolledAt: at })
    .onConflictDoUpdate({ target: mailboxState.folder, set: { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid, lastPolledAt: at } })
    .run();
}

/** Reads every new message of the inbox folder and imports the agency replies among them. */
export async function pollMailbox(db: Db, mailbox: Mailbox, now: Date = new Date()): Promise<number> {
  let imported = 0;
  for (;;) {
    const state = db.select().from(mailboxState).where(eq(mailboxState.folder, mailbox.folder)).get();
    const cursor = state ? { uidValidity: state.uidValidity, lastUid: state.lastUid } : null;
    const read = await mailbox.readNew(cursor, firstPollSince(db, now), POLL_BATCH);
    for (const message of read.messages) {
      if (await importOne(db, mailbox, message, read.cursor.uidValidity, now)) imported++;
    }
    db.transaction((tx) => saveCursor(tx, mailbox.folder, read.cursor, now));
    if (read.messages.length < POLL_BATCH) return imported;
  }
}

/** The recurring IMAP poll; the next poll is scheduled by the caller whatever the outcome. */
export function imapPollHandler(db: Db, mailbox: () => Mailbox | null): JobHandler {
  return async (_job, now) => {
    const box = mailbox();
    if (!box) return { status: "done" };
    try {
      const imported = await pollMailbox(db, box, now);
      markServiceOk(db, "IMAP", now);
      if (imported > 0) logger.info({ imported }, "mailbox polled");
      return { status: "done" };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      logger.warn({ err: error }, "mailbox poll failed");
      markServiceFailing(db, "IMAP", message, now);
      return { status: "failed", error: message };
    }
  };
}
