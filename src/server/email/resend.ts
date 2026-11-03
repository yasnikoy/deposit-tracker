import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { agencies, billsOfLading, documents, emailAttachments, emails, requests } from "../db/schema";
import { DomainError } from "../errors";
import { enqueueJob } from "../jobs";
import { getSetting } from "../settings";
import type { DraftAttachment, EmailDraft } from "./compose";

export type QueueResendInput = {
  emailId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** The original's attachments kept in the preview. */
  documentIds: number[];
};

/** B/Ls whose requests no longer take a resend: settled ones. */
const SETTLED = new Set(["COLLECTED", "ACCOUNTING_PENDING"]);

/**
 * The request email a resend repeats: the email itself, or the original a resend points to.
 * It must have gone out, and at least one of its B/Ls must still be open.
 */
function originalOf(tx: DbOrTx, emailId: number) {
  const email = tx.select().from(emails).where(eq(emails.id, emailId)).get();
  if (!email) throw new DomainError("errors.notFound");
  const original = email.resendOfEmailId ? tx.select().from(emails).where(eq(emails.id, email.resendOfEmailId)).get()! : email;
  const items = tx
    .select({ blId: billsOfLading.id, blNo: billsOfLading.blNo, status: billsOfLading.status, voidedAt: billsOfLading.voidedAt, type: requests.type, attemptNo: requests.attemptNo })
    .from(requests)
    .innerJoin(billsOfLading, eq(billsOfLading.id, requests.blId))
    .where(eq(requests.emailId, original.id))
    .orderBy(billsOfLading.paidAt, billsOfLading.id)
    .all();
  if (original.direction !== "OUT" || original.sendStatus !== "SENT" || items.length === 0) throw new DomainError("requests.errors.resendNotSent");
  if (!items.some((i) => !i.voidedAt && !SETTLED.has(i.status))) throw new DomainError("requests.errors.resendClosed");
  return { original, items };
}

function attachmentsOf(tx: DbOrTx, emailId: number): DraftAttachment[] {
  return tx
    .select({ id: documents.id, originalName: documents.originalName, sizeBytes: documents.sizeBytes, kind: documents.kind })
    .from(emailAttachments)
    .innerJoin(documents, eq(documents.id, emailAttachments.documentId))
    .where(eq(emailAttachments.emailId, emailId))
    // In the order the original carried them.
    .orderBy(sql`${emailAttachments}.rowid`)
    .all()
    .map((d) => ({
      documentId: d.id,
      originalName: d.originalName,
      sizeBytes: d.sizeBytes,
      kind: d.kind === "RECEIPT" || d.kind === "INVOICE" || d.kind === "STANDING" ? d.kind : "FORM",
      blNo: null,
    }));
}

/**
 * The preview of a resend: the original request email as it was sent (recipients, subject,
 * body and attachments), to be sent again as a new email. Nothing is saved here.
 */
export function prepareResend(db: Db, actor: AuthUser, input: { emailId: number }): EmailDraft & { resendOfEmailId: number } {
  authorize(actor, "request.resend");
  const { original, items } = originalOf(db, input.emailId);
  const agency = original.agencyId ? db.select({ id: agencies.id, name: agencies.name }).from(agencies).where(eq(agencies.id, original.agencyId)).get() : undefined;
  return {
    resendOfEmailId: original.id,
    agencyId: agency?.id ?? 0,
    agencyName: agency?.name ?? "",
    items: items.map((i) => ({ blId: i.blId, blNo: i.blNo, type: i.type, kind: i.attemptNo > 1 ? "FOLLOW_UP" : "FIRST", attemptNo: i.attemptNo })),
    to: original.to,
    cc: original.cc,
    bcc: original.bcc,
    subject: original.subject,
    body: original.bodyText,
    // A new email in the same form as the original, never a reply to it.
    thread: null,
    attachments: attachmentsOf(db, original.id),
    maxAttachmentBytes: getSetting("email.maxAttachmentMb", {}, db) * 1024 * 1024,
    missingEvidence: [],
    portalFiling: [],
    portalUrl: null,
  };
}

/**
 * Sends a request email again, e.g. to the right recipients: a new email (not a reply) that
 * points to the original. The requests keep their attempt, date and status; a resend is no
 * new request. Agency replies to it link to the same B/Ls, and later follow-ups reply to it.
 */
export function queueResend(db: Db, actor: AuthUser, input: QueueResendInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "request.resend");
  return db.transaction((tx) => {
    const { original, items } = originalOf(tx, input.emailId);
    const allowed = new Map(attachmentsOf(tx, original.id).map((a) => [a.documentId, a]));
    if (!input.documentIds.every((id) => allowed.has(id))) throw new DomainError("requests.errors.attachment");
    const kept = [...new Set(input.documentIds)];
    const bytes = kept.reduce((sum, id) => sum + allowed.get(id)!.sizeBytes, 0);
    const maxMb = getSetting("email.maxAttachmentMb", {}, tx);
    if (bytes > maxMb * 1024 * 1024) throw new DomainError("requests.errors.tooLarge", { max: maxMb });
    const fromAddress = getSetting("email.fromAddress", {}, tx);
    if (!fromAddress) throw new DomainError("requests.errors.noSender");

    const at = now.toISOString();
    const email = tx
      .insert(emails)
      .values({
        direction: "OUT",
        agencyId: original.agencyId,
        messageId: `<${randomUUID()}@${fromAddress.split("@")[1]}>`,
        inReplyTo: null,
        references: [],
        fromAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyText: input.body,
        sendStatus: "QUEUED",
        queuedBy: actor.id,
        roleUsed,
        resendOfEmailId: original.id,
        createdAt: at,
      })
      .returning()
      .get();
    if (kept.length > 0) tx.insert(emailAttachments).values(kept.map((documentId) => ({ emailId: email.id, documentId }))).run();
    for (const item of items) {
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "request.resend",
          entityType: "bill_of_lading",
          entityId: item.blId,
          after: { emailId: email.id, resendOfEmailId: original.id, subject: input.subject, to: input.to, cc: input.cc },
        },
        now,
      );
    }
    enqueueJob(tx, "SEND_EMAIL", { emailId: email.id }, now, now);
    return email.id;
  });
}

/** The B/Ls of a resend's original requests, for the audit rows of its send result. */
export function resendBlIds(tx: DbOrTx, email: { resendOfEmailId: number | null }): number[] {
  if (!email.resendOfEmailId) return [];
  return tx
    .select({ blId: requests.blId })
    .from(requests)
    .innerJoin(billsOfLading, eq(billsOfLading.id, requests.blId))
    .where(and(eq(requests.emailId, email.resendOfEmailId), isNull(billsOfLading.voidedAt)))
    .all()
    .map((r) => r.blId);
}

/** Resends of the given request emails, so they count as part of those emails' threads. */
export function resendsOf(tx: DbOrTx, emailIds: number[]) {
  if (emailIds.length === 0) return [];
  return tx.select().from(emails).where(inArray(emails.resendOfEmailId, emailIds)).all();
}
