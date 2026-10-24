import "server-only";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday } from "@/domain/business-days";
import type { Role } from "@/domain/roles";
import { writeAudit } from "../audit";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { billsOfLading, documents, emailAttachments, emails, requests } from "../db/schema";
import { DomainError } from "../errors";
import { readDocument, storeGeneratedDocument } from "../files";
import { enqueueJob, type JobHandler, type JobHandlers } from "../jobs";
import { logger } from "../logger";
import { markServiceFailing, markServiceOk } from "../service-status";
import { getSetting } from "../settings";
import { lockForDraft, releaseDraftLocks } from "../draft-locks";
import { buildRequestDrafts } from "./compose";
import type { MailTransport } from "./transport";

/** Retries after the first attempt, then the request is marked failed (ARCHITECTURE → Jobs). */
export const SEND_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;

export type QueueEmailInput = {
  blIds: number[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** The attachments kept in the preview; only the draft's own files can be sent. */
  documentIds: number[];
};

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Sends one previewed email: the draft is rebuilt on the server for the same B/Ls (so due
 * state, forms, recipients and threading are checked again), the user's edits to recipients,
 * subject and body are kept as sent, and the send job is queued. Requests count as sent
 * only once the job succeeds.
 */
export function queueRequestEmail(db: Db, actor: AuthUser, input: QueueEmailInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "request.sendEmail");
  return db.transaction((tx) => {
    const drafts = buildRequestDrafts(tx, input.blIds, now);
    const draft = drafts.length === 1 ? drafts[0] : null;
    if (!draft || !sameSet(draft.items.map((i) => i.blId), [...new Set(input.blIds)])) throw new DomainError("requests.errors.draftChanged");
    lockForDraft(tx, actor, input.blIds, now);

    const allowed = new Map(draft.attachments.map((a) => [a.documentId, a]));
    if (!input.documentIds.every((id) => allowed.has(id))) throw new DomainError("requests.errors.attachment");
    const attachments = [...new Set(input.documentIds)].map((id) => allowed.get(id)!);
    const bytes = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
    if (bytes > draft.maxAttachmentBytes) {
      throw new DomainError("requests.errors.tooLarge", { max: getSetting("email.maxAttachmentMb", {}, tx) });
    }
    const fromAddress = getSetting("email.fromAddress", {}, tx);
    if (!fromAddress) throw new DomainError("requests.errors.noSender");

    const at = now.toISOString();
    const email = tx
      .insert(emails)
      .values({
        direction: "OUT",
        agencyId: draft.agencyId,
        messageId: `<${randomUUID()}@${fromAddress.split("@")[1]}>`,
        inReplyTo: draft.thread?.messageId ?? null,
        references: draft.thread ? [...draft.thread.references, draft.thread.messageId] : [],
        fromAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyText: input.body,
        sendStatus: "QUEUED",
        queuedBy: actor.id,
        roleUsed,
        createdAt: at,
      })
      .returning()
      .get();
    if (attachments.length > 0) {
      tx.insert(emailAttachments).values(attachments.map((a) => ({ emailId: email.id, documentId: a.documentId }))).run();
    }
    for (const item of draft.items) {
      tx.insert(requests)
        .values({
          blId: item.blId,
          type: "REFUND",
          channel: "EMAIL",
          attemptNo: item.attemptNo,
          sendStatus: "QUEUED",
          emailId: email.id,
          createdBy: actor.id,
          createdAt: at,
        })
        .run();
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "request.queue",
          entityType: "bill_of_lading",
          entityId: item.blId,
          after: { emailId: email.id, attemptNo: item.attemptNo, subject: input.subject, to: input.to, cc: input.cc },
        },
        now,
      );
    }
    releaseDraftLocks(tx, actor, input.blIds);
    enqueueJob(tx, "SEND_EMAIL", { emailId: email.id }, now, now);
    return email.id;
  });
}

type EmailRow = typeof emails.$inferSelect;

async function buildRaw(db: DbOrTx, email: EmailRow, now: Date): Promise<Buffer> {
  const files = db
    .select({ doc: documents })
    .from(emailAttachments)
    .innerJoin(documents, eq(documents.id, emailAttachments.documentId))
    .where(eq(emailAttachments.emailId, email.id))
    .all()
    .map(({ doc }) => ({ filename: doc.originalName, content: readDocument(doc), contentType: doc.mimeType }));
  const fromName = getSetting("email.fromName", {}, db);
  return new MailComposer({
    from: fromName ? { name: fromName, address: email.fromAddress } : email.fromAddress,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    text: email.bodyText,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo ?? undefined,
    references: email.references.length > 0 ? email.references : undefined,
    date: now,
    attachments: files,
  })
    .compile()
    .build();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** The audit actor of a queued email: the user who sent it, with the role used then. */
const senderOf = (email: EmailRow) => ({ actorUserId: email.queuedBy, roleUsed: (email.roleUsed as Role | null) ?? null });

function markSent(db: Db, email: EmailRow, raw: Buffer, dryRun: boolean, now: Date): void {
  db.transaction((tx) => {
    const at = now.toISOString();
    const rawDoc = storeGeneratedDocument(
      tx,
      { kind: "OTHER", originalName: `e-posta-${email.id}.eml`, content: raw, createdBy: email.queuedBy!, ownerType: "email", ownerId: email.id },
      now,
    );
    tx.update(emails).set({ sendStatus: "SENT", sentAt: at, dryRun, rawDocumentId: rawDoc.id, lastError: null }).where(eq(emails.id, email.id)).run();
    const sentRequests = tx.select().from(requests).where(eq(requests.emailId, email.id)).all();
    tx.update(requests)
      .set({ sendStatus: "SENT", requestedOn: istanbulToday(now), sentAt: at })
      .where(inArray(requests.id, sentRequests.map((r) => r.id)))
      .run();
    for (const request of sentRequests) {
      const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, request.blId)).get()!;
      let status = bl.status as StoredBlStatus;
      try {
        // A B/L voided while the email was queued stays as it is; the email went out anyway.
        if (!bl.voidedAt) status = nextStatus(status, "REFUND_REQUEST_SENT");
      } catch (error) {
        if (!(error instanceof InvalidTransitionError)) throw error;
        logger.warn({ blId: bl.id, from: bl.status }, "request sent for a B/L that no longer takes requests");
      }
      if (status !== bl.status) tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
      writeAudit(
        tx,
        {
          ...senderOf(email),
          action: "request.sent",
          entityType: "bill_of_lading",
          entityId: bl.id,
          before: { status: bl.status },
          after: { status, emailId: email.id, attemptNo: request.attemptNo, dryRun },
        },
        now,
      );
    }
    if (!dryRun) {
      markServiceOk(tx, "SMTP", now);
      enqueueJob(tx, "COPY_TO_SENT_FOLDER", { emailId: email.id }, now, now);
    }
  });
}

function markFailed(db: Db, email: EmailRow, error: string, now: Date): void {
  db.transaction((tx) => {
    tx.update(emails).set({ sendStatus: "FAILED", lastError: error }).where(eq(emails.id, email.id)).run();
    const failed = tx.select().from(requests).where(eq(requests.emailId, email.id)).all();
    tx.update(requests).set({ sendStatus: "FAILED", failureReason: error }).where(eq(requests.emailId, email.id)).run();
    for (const request of failed) {
      writeAudit(
        tx,
        { ...senderOf(email), action: "request.failed", entityType: "bill_of_lading", entityId: request.blId, after: { emailId: email.id, error } },
        now,
      );
    }
  });
}

function sendEmailHandler(db: Db, transport: () => MailTransport): JobHandler {
  return async (job, now) => {
    const email = db.select().from(emails).where(eq(emails.id, Number(job.payload.emailId))).get();
    // Already handled (e.g. the job ran again after a restart): never send twice.
    if (!email || email.sendStatus !== "QUEUED") return { status: "done" };
    const mail = transport();
    let raw: Buffer;
    try {
      raw = await buildRaw(db, email, now);
      await mail.send(raw, { from: email.fromAddress, to: [...email.to, ...email.cc, ...email.bcc] });
    } catch (error) {
      const message = errorText(error);
      logger.warn({ err: error, emailId: email.id, attempt: job.attempts }, "email send failed");
      db.update(emails).set({ sendAttempts: job.attempts, lastError: message }).where(eq(emails.id, email.id)).run();
      markServiceFailing(db, "SMTP", message, now);
      const delay = SEND_RETRY_DELAYS_MINUTES[job.attempts - 1];
      if (delay !== undefined) return { status: "retry", at: new Date(now.getTime() + delay * 60_000), error: message };
      markFailed(db, email, message, now);
      return { status: "failed", error: message };
    }
    db.update(emails).set({ sendAttempts: job.attempts }).where(eq(emails.id, email.id)).run();
    markSent(db, email, raw, mail.dryRun, now);
    logger.info({ emailId: email.id, dryRun: mail.dryRun }, mail.dryRun ? "email stored (dry-run)" : "email sent");
    return { status: "done" };
  };
}

function copyToSentHandler(db: Db, transport: () => MailTransport): JobHandler {
  return async (job, now) => {
    const email = db.select().from(emails).where(eq(emails.id, Number(job.payload.emailId))).get();
    if (!email?.rawDocumentId || email.copiedToSentAt) return { status: "done" };
    const raw = readDocument(db.select().from(documents).where(eq(documents.id, email.rawDocumentId)).get()!);
    try {
      await transport().appendToSent(raw);
    } catch (error) {
      const message = errorText(error);
      markServiceFailing(db, "IMAP", message, now);
      const delay = SEND_RETRY_DELAYS_MINUTES[job.attempts - 1];
      if (delay !== undefined) return { status: "retry", at: new Date(now.getTime() + delay * 60_000), error: message };
      return { status: "failed", error: message };
    }
    db.update(emails).set({ copiedToSentAt: now.toISOString() }).where(eq(emails.id, email.id)).run();
    markServiceOk(db, "IMAP", now);
    return { status: "done" };
  };
}

export function emailJobHandlers(db: Db, transport: () => MailTransport): Pick<JobHandlers, "SEND_EMAIL" | "COPY_TO_SENT_FOLDER"> {
  return { SEND_EMAIL: sendEmailHandler(db, transport), COPY_TO_SENT_FOLDER: copyToSentHandler(db, transport) };
}

/** Admin "send test" in the email settings; honours dry-run like every other send. */
export async function sendTestEmail(db: Db, actor: AuthUser, input: { to: string }, transport: MailTransport, now: Date = new Date()) {
  const roleUsed = authorize(actor, "email.sendTest");
  const fromAddress = getSetting("email.fromAddress", {}, db);
  if (!fromAddress) throw new DomainError("requests.errors.noSender");
  const raw = await new MailComposer({
    from: fromAddress,
    to: input.to,
    subject: "Depozito Takip – deneme e-postası",
    text: "Bu e-posta, Depozito Takip uygulamasının e-posta ayarlarını denemek için gönderildi.",
    date: now,
  })
    .compile()
    .build();
  try {
    await transport.send(raw, { from: fromAddress, to: [input.to] });
  } catch (error) {
    if (!transport.dryRun) markServiceFailing(db, "SMTP", errorText(error), now);
    throw new DomainError("emailSettings.testFailed", { error: errorText(error) });
  }
  if (!transport.dryRun) markServiceOk(db, "SMTP", now);
  writeAudit(db, { actorUserId: actor.id, roleUsed, action: "email.sendTest", entityType: "setting", entityId: "email", after: { to: input.to, dryRun: transport.dryRun } }, now);
  return { dryRun: transport.dryRun };
}
