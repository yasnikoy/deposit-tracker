import "server-only";
import { createHash } from "node:crypto";
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { and, eq } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import type { Role } from "@/domain/roles";
import { writeAudit } from "../audit";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { billsOfLading, emailAttachments, emailBlLinks, emails } from "../db/schema";
import { DomainError } from "../errors";
import { storeImportedDocument } from "../files";
import { getSetting } from "../settings";

/** An email as the app keeps it, read from an Outlook file. */
export type ParsedMessage = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  date: Date | null;
  attachments: { filename: string; content: Buffer; contentType: string }[];
};

const MIME = { eml: "message/rfc822", msg: "application/vnd.ms-outlook" } as const;
type Format = keyof typeof MIME;

/** A message without a Message-ID gets a stable one from its content, so it is still stored once. */
const fallbackId = (raw: Buffer) => `<archived-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}@deposit.invalid>`;

const messageIds = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value ? value.split(/\s+/) : []).map((id) => id.trim()).filter(Boolean);

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => a.value.map((v) => v.address ?? "")).filter(Boolean);

/** Crude text of an HTML-only message; the app shows emails as plain text, never as HTML. */
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

async function messageFromEml(raw: Buffer): Promise<ParsedMessage> {
  const mail = await simpleParser(raw, { skipImageLinks: true });
  return {
    messageId: mail.messageId ?? fallbackId(raw),
    inReplyTo: messageIds(mail.inReplyTo)[0] ?? null,
    references: messageIds(mail.references),
    from: mail.from?.value[0]?.address?.toLowerCase() ?? "",
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject ?? "",
    text: mail.text?.trim() || (typeof mail.html === "string" ? htmlToText(mail.html) : ""),
    date: mail.date ?? null,
    attachments: mail.attachments
      // Inline images (signature logos) belong to the message body, not to the B/L.
      .filter((a) => !a.related)
      .map((a, i) => ({ filename: a.filename || `ek-${i + 1}`, content: a.content, contentType: a.contentType || "application/octet-stream" })),
  };
}

type MsgFields = Pick<FieldsData, "messageId" | "headers" | "senderEmail" | "senderSmtpAddress" | "subject" | "body" | "bodyHtml" | "messageDeliveryTime" | "clientSubmitTime"> & {
  recipients?: Pick<FieldsData, "recipType" | "email" | "smtpAddress">[];
  attachments?: (Pick<FieldsData, "fileName" | "attachmentHidden" | "attachMimeTag"> & { innerMsgContent?: true })[];
};

/** One header of the transport headers Outlook keeps with a received message (continuation lines joined). */
const header = (headers: string | undefined, name: string): string | undefined =>
  new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r?\\n[ \\t].*)*)`, "im").exec(headers ?? "")?.[1].replace(/\r?\n[ \t]+/g, " ").trim();

/** An Outlook .msg in the shape of a parsed email; exported for tests. */
export function messageFromMsg(
  fields: MsgFields,
  attachment: (a: NonNullable<MsgFields["attachments"]>[number]) => { fileName: string; content: Uint8Array },
  raw: Buffer,
): ParsedMessage {
  const address = (r: { email?: string; smtpAddress?: string }) => (r.smtpAddress || r.email || "").toLowerCase();
  const recipients = (type: "to" | "cc") => (fields.recipients ?? []).filter((r) => r.recipType === type).map(address).filter(Boolean);
  const sent = fields.messageDeliveryTime ?? fields.clientSubmitTime;
  return {
    messageId: fields.messageId || header(fields.headers, "Message-ID") || fallbackId(raw),
    inReplyTo: messageIds(header(fields.headers, "In-Reply-To"))[0] ?? null,
    references: messageIds(header(fields.headers, "References")),
    from: (fields.senderSmtpAddress || fields.senderEmail || "").toLowerCase(),
    to: recipients("to"),
    cc: recipients("cc"),
    subject: fields.subject ?? "",
    text: fields.body?.trim() || (fields.bodyHtml ? htmlToText(fields.bodyHtml) : ""),
    date: sent ? new Date(sent) : null,
    attachments: (fields.attachments ?? [])
      // Hidden attachments are inline images; an attached message has no file of its own here.
      .filter((a) => !a.attachmentHidden && !a.innerMsgContent)
      .map((a, i) => {
        const file = attachment(a);
        return { filename: file.fileName || `ek-${i + 1}`, content: Buffer.from(file.content), contentType: a.attachMimeTag || "application/octet-stream" };
      }),
  };
}

async function parse(format: Format, raw: Buffer): Promise<ParsedMessage> {
  try {
    if (format === "eml") return await messageFromEml(raw);
    const reader = new MsgReader(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    const fields = reader.getFileData();
    if (fields.error) throw new Error(fields.error);
    return messageFromMsg(fields, (a) => reader.getAttachment(a as FieldsData), raw);
  } catch {
    throw new DomainError("archive.errors.unreadable");
  }
}

type BlRow = typeof billsOfLading.$inferSelect;

/**
 * Links an email to a B/L; the first link also gives the email its agency. Returns the audit
 * row (for undo), or null when the pair was linked already. A link undone earlier is made
 * again in place (the audit log keeps both steps).
 */
function linkEmail(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, emailId: number, bl: BlRow, now: Date): number | null {
  const at = now.toISOString();
  const row = tx.select().from(emailBlLinks).where(and(eq(emailBlLinks.emailId, emailId), eq(emailBlLinks.blId, bl.id))).get();
  if (row && row.unlinkedAt === null) return null;
  if (!row) tx.insert(emailBlLinks).values({ emailId, blId: bl.id, linkedBy: "MANUAL", linkedByUser: actor.id, createdAt: at }).run();
  else {
    tx.update(emailBlLinks)
      .set({ linkedBy: "MANUAL", linkedByUser: actor.id, createdAt: at, unlinkedAt: null, unlinkedBy: null })
      .where(and(eq(emailBlLinks.emailId, emailId), eq(emailBlLinks.blId, bl.id)))
      .run();
  }
  return writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "email.link", entityType: "bill_of_lading", entityId: bl.id, after: { emailId, source: "ARCHIVE" } }, now);
}

/**
 * Archives an email a user dragged from Outlook (.eml or .msg) on a B/L: the original file is
 * kept as dropped, so it opens in Outlook again to continue the conversation, and the message
 * with its attachments shows on the B/L. The same message dropped on another B/L is stored once
 * and linked there too. The app never interprets it (rule 10). Returns the audit row for undo.
 */
export async function archiveEmail(db: Db, actor: AuthUser, input: { blId: number; fileName: string; content: Buffer }, now: Date = new Date()): Promise<number[]> {
  const roleUsed = authorize(actor, "email.link");
  const extension = input.fileName.toLowerCase().split(".").pop() ?? "";
  if (extension !== "eml" && extension !== "msg") throw new DomainError("archive.errors.type");
  const maxMb = getSetting("rules.maxFileSizeMb", {}, db);
  if (input.content.length === 0) throw new DomainError("files.errors.empty");
  if (input.content.length > maxMb * 1024 * 1024) throw new DomainError("files.errors.size", { max: maxMb });
  const message = await parse(extension, input.content);

  return db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    let emailId = tx.select({ id: emails.id }).from(emails).where(eq(emails.messageId, message.messageId)).get()?.id;
    if (emailId === undefined) {
      const at = now.toISOString();
      emailId = tx
        .insert(emails)
        .values({
          direction: "IN",
          agencyId: bl.agencyId,
          messageId: message.messageId,
          inReplyTo: message.inReplyTo,
          references: message.references,
          fromAddress: message.from,
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          bodyText: message.text,
          receivedAt: (message.date && !Number.isNaN(message.date.getTime()) ? message.date : now).toISOString(),
          createdAt: at,
        })
        .returning({ id: emails.id })
        .get().id;
      const raw = storeImportedDocument(tx, { originalName: input.fileName, content: input.content, mimeType: MIME[extension], ownerType: "email", ownerId: emailId }, now);
      tx.update(emails).set({ rawDocumentId: raw.id }).where(eq(emails.id, emailId)).run();
      for (const attachment of message.attachments) {
        if (attachment.content.length === 0) continue;
        const doc = storeImportedDocument(tx, { originalName: attachment.filename, content: attachment.content, mimeType: attachment.contentType, ownerType: "email", ownerId: emailId }, now);
        tx.insert(emailAttachments).values({ emailId, documentId: doc.id }).run();
      }
    }
    const auditId = linkEmail(tx, actor, roleUsed, emailId, bl, now);
    if (auditId === null) throw new DomainError("archive.errors.alreadyLinked", { bl: bl.blNo });
    return [auditId];
  });
}
