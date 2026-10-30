import "server-only";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { renderTemplate, type EmailTemplateKey } from "@/domain/email-templates";
import type { RequestKind } from "@/domain/due-requests";
import type { RequestType } from "@/domain/records";
import { formatTimestamp } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { billsOfLading, containers, emailBlLinks, emails, ledgerEntries, requests } from "../db/schema";
import { DomainError } from "../errors";
import { currentBlForm } from "../forms";
import { dueEntries, type DueEntry } from "../requests";
import { lacksPaymentEvidence, paymentEvidence } from "../payments";
import { getSetting } from "../settings";
import { currentStandingDocuments } from "../standing-documents";
import { lockForDraft, releaseDraftLocks } from "../draft-locks";
import { getEmailTemplate } from "./templates";

export type DraftAttachment = {
  documentId: number;
  originalName: string;
  sizeBytes: number;
  kind: "FORM" | "RECEIPT" | "INVOICE" | "STANDING";
  /** The B/L the file belongs to; null for standing documents. */
  blNo: string | null;
};

export type DraftItem = { blId: number; blNo: string; type: RequestType; kind: RequestKind; attemptNo: number };

/** Follow-ups reply to the latest message of the B/L's thread, ours or the agency's. */
export type DraftThread = { emailId: number; messageId: string; references: string[]; subject: string };

type ThreadEmail = DraftThread & { fromAddress: string; to: string[]; cc: string[]; bodyText: string; sentAt: string | null; incoming: boolean };

export type EmailDraft = {
  agencyId: number;
  agencyName: string;
  items: DraftItem[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  thread: DraftThread | null;
  attachments: DraftAttachment[];
  maxAttachmentBytes: number;
  /** B/Ls whose payment has no receipt or invoice yet: sending needs a confirmation (rule 12). */
  missingEvidence: string[];
};

/**
 * The latest message of a B/L's request chain of one type, to reply to: our last sent request
 * email, or a later agency email linked to the B/L (for portal agencies, the one linked by
 * hand). The statement chain starts with our first statement request, so only agency emails
 * after it belong to it.
 */
function lastThread(tx: DbOrTx, blId: number, type: RequestType): ThreadEmail | null {
  const fields = {
    emailId: emails.id,
    messageId: emails.messageId,
    references: emails.references,
    subject: emails.subject,
    fromAddress: emails.fromAddress,
    to: emails.to,
    cc: emails.cc,
    bodyText: emails.bodyText,
    sentAt: emails.sentAt,
    receivedAt: emails.receivedAt,
  };
  const sent = tx
    .select(fields)
    .from(requests)
    .innerJoin(emails, eq(emails.id, requests.emailId))
    .where(and(eq(requests.blId, blId), eq(requests.type, type), eq(requests.sendStatus, "SENT"), isNotNull(requests.emailId)))
    .orderBy(desc(requests.id))
    .get();
  const received = tx
    .select(fields)
    .from(emailBlLinks)
    .innerJoin(emails, eq(emails.id, emailBlLinks.emailId))
    .where(and(eq(emailBlLinks.blId, blId), eq(emails.direction, "IN")))
    .orderBy(desc(emails.receivedAt), desc(emails.id))
    .get();
  const statementReply = type === "DEDUCTION_STATEMENT" && received && sent?.sentAt && received.receivedAt! > sent.sentAt;
  const latest = [sent, type === "REFUND" || statementReply ? received : undefined]
    .filter((e) => e !== undefined)
    .sort((a, b) => (b.receivedAt ?? b.sentAt ?? "").localeCompare(a.receivedAt ?? a.sentAt ?? ""))[0];
  if (!latest) return null;
  const { receivedAt, ...thread } = latest;
  return { ...thread, sentAt: receivedAt ?? thread.sentAt, incoming: receivedAt !== null };
}

function lastPortalRef(tx: DbOrTx, blId: number): string {
  const row = tx
    .select({ portalRef: requests.portalRef })
    .from(requests)
    .where(and(eq(requests.blId, blId), eq(requests.channel, "PORTAL"), isNotNull(requests.portalRef)))
    .orderBy(desc(requests.id))
    .get();
  return row?.portalRef ?? "";
}

const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

/**
 * Builds the request emails for the selected B/Ls: refund requests, or deduction-statement
 * requests for B/Ls with an unexplained deduction. Per agency: one email per B/L, or for
 * batch agencies one email for all first requests (one section per request type) plus one
 * reply per existing thread for follow-ups (B/Ls that share a thread share the reply).
 * Nothing is saved here.
 */
export function buildRequestDrafts(tx: DbOrTx, blIds: number[], now: Date): EmailDraft[] {
  const unique = [...new Set(blIds)];
  const entries = dueEntries(tx, now, {}, unique);
  const formRequired = getSetting("rules.blockSendingWithoutForm", {}, tx);
  for (const id of unique) {
    const entry = entries.find((e) => e.bl.id === id);
    const blNo = entry?.bl.blNo ?? tx.select({ blNo: billsOfLading.blNo }).from(billsOfLading).where(eq(billsOfLading.id, id)).get()?.blNo;
    if (!blNo) throw new DomainError("errors.notFound");
    if (!entry || entry.state.list === null) throw new DomainError("requests.errors.notDueBl", { bl: blNo });
    const refund = entry.state.type === "REFUND";
    if (refund && entry.agency.requestChannel === "PORTAL" && entry.state.kind === "FIRST") throw new DomainError("requests.errors.portalFirst", { bl: blNo });
    if (refund && formRequired && !currentBlForm(tx, id)) throw new DomainError("requests.errors.formMissing", { bl: blNo });
    if (entry.agency.toRecipients.length === 0) throw new DomainError("requests.errors.noRecipients", { agency: entry.agency.name });
  }

  // Group: agency → (first requests | thread of the follow-up), or one group per B/L.
  const groups = new Map<string, { entries: DueEntry[]; thread: ThreadEmail | null }>();
  for (const entry of entries.sort((a, b) => a.bl.paidAt.localeCompare(b.bl.paidAt) || a.bl.id - b.bl.id)) {
    const thread = entry.state.kind === "FOLLOW_UP" ? lastThread(tx, entry.bl.id, entry.state.type) : null;
    const key = entry.agency.batchSending
      ? `${entry.agency.id}:${entry.state.kind === "FIRST" ? "first" : `thread-${thread?.emailId ?? "none"}`}`
      : `${entry.agency.id}:bl-${entry.bl.id}`;
    const group = groups.get(key) ?? { entries: [], thread };
    group.entries.push(entry);
    groups.set(key, group);
  }

  const signature = getSetting("email.signature", {}, tx);
  const defaultCc = getSetting("email.defaultCc", {}, tx);
  const defaultBcc = getSetting("email.defaultBcc", {}, tx);
  const attachStanding = getSetting("rules.attachStandingDocuments", {}, tx);
  const standing = attachStanding ? currentStandingDocuments(tx) : [];
  const maxAttachmentBytes = getSetting("email.maxAttachmentMb", {}, tx) * 1024 * 1024;

  return [...groups.values()].map(({ entries: group, thread }) => {
    const agency = group[0].agency;
    const lines = group.map((entry) => blValues(tx, entry));
    const batched = group.length > 1;
    const { type, kind } = group[0].state;
    const templateKey: EmailTemplateKey = batched
      ? "BATCH"
      : type === "DEDUCTION_STATEMENT"
        ? "DEDUCTION_STATEMENT"
        : kind === "FIRST"
          ? "REFUND_REQUEST"
          : "FOLLOW_UP";
    const template = getEmailTemplate(tx, templateKey);
    const lineTemplate = getEmailTemplate(tx, "BATCH_LINE").body;
    const section = (sectionType: RequestType) =>
      lines
        .filter((_, i) => group[i].state.type === sectionType)
        // A statement line shows the unexplained deduction as its amount.
        .map((l) => renderTemplate(lineTemplate, sectionType === "DEDUCTION_STATEMENT" ? { ...l, amount: l.deduction_amount } : l))
        .join("\n");
    const values: Record<string, string> = batched
      ? {
          agency_name: agency.name,
          bl_no: lines.map((l) => l.bl_no).join(", "),
          refund_section: section("REFUND"),
          statement_section: section("DEDUCTION_STATEMENT"),
          signature,
        }
      : { ...lines[0], agency_name: agency.name, signature };

    const attachments: DraftAttachment[] = group.flatMap((entry) => blAttachments(tx, entry));
    for (const doc of standing) {
      attachments.push({ documentId: doc.documentId, originalName: doc.originalName, sizeBytes: doc.sizeBytes, kind: "STANDING", blNo: null });
    }

    return {
      agencyId: agency.id,
      agencyName: agency.name,
      items: group.map((entry) => ({ blId: entry.bl.id, blNo: entry.bl.blNo, type: entry.state.type, kind: entry.state.kind, attemptNo: entry.state.attemptNo })),
      to: agency.toRecipients,
      cc: [...new Set([...agency.ccRecipients, ...defaultCc])],
      bcc: defaultBcc,
      subject: thread ? replySubject(thread.subject) : renderTemplate(template.subject, values),
      body: renderTemplate(template.body, values) + (thread ? quoteOf(tx, thread) : ""),
      thread: thread && { emailId: thread.emailId, messageId: thread.messageId, references: thread.references, subject: thread.subject },
      attachments,
      maxAttachmentBytes,
      missingEvidence: group.filter((entry) => lacksPaymentEvidence(tx, entry.bl)).map((entry) => entry.bl.blNo),
    };
  });
}

/**
 * The earlier email below the new text, the way Outlook quotes on "Reply all". Its own text
 * already holds the quotes before it, so the whole chain stays readable in each follow-up.
 */
function quoteOf(tx: DbOrTx, thread: ThreadEmail): string {
  const fromName = getSetting("email.fromName", {}, tx);
  const header = renderTemplate(getEmailTemplate(tx, "REPLY_QUOTE").body, {
    from: fromName && !thread.incoming ? `${fromName} <${thread.fromAddress}>` : thread.fromAddress,
    sent_at: thread.sentAt ? formatTimestamp(thread.sentAt) : "",
    to: thread.to.join("; "),
    cc_section: thread.cc.join("; "),
    subject: thread.subject,
  });
  return header + thread.bodyText;
}

function blValues(tx: DbOrTx, entry: DueEntry): Record<string, string> {
  const numbers = tx
    .select({ containerNo: containers.containerNo })
    .from(containers)
    .where(eq(containers.blId, entry.bl.id))
    .orderBy(containers.id)
    .all()
    .map((c) => c.containerNo);
  const ledger = tx.select().from(ledgerEntries).where(eq(ledgerEntries.blId, entry.bl.id)).all();
  return {
    bl_no: entry.bl.blNo,
    containers: numbers.join(", "),
    amount: formatAmount(blBalance(ledger, entry.bl.currency).depositMinor),
    currency: entry.bl.currency,
    attempt_no: String(entry.state.attemptNo),
    portal_ref: lastPortalRef(tx, entry.bl.id),
    deduction_amount: entry.unexplainedMinor === null ? "" : formatAmount(entry.unexplainedMinor),
  };
}

/** Every request attaches the B/L's uploaded form and the deposit receipt (or invoice) of its payment, when there is one. */
function blAttachments(tx: DbOrTx, entry: DueEntry): DraftAttachment[] {
  const result: DraftAttachment[] = [];
  const form = currentBlForm(tx, entry.bl.id);
  if (form) result.push({ documentId: form.id, originalName: form.originalName, sizeBytes: form.sizeBytes, kind: "FORM", blNo: entry.bl.blNo });
  const evidence = paymentEvidence(tx, entry.bl.depositPaymentId);
  if (evidence) {
    result.push({
      documentId: evidence.id,
      originalName: evidence.originalName,
      sizeBytes: evidence.sizeBytes,
      kind: evidence.kind === "INVOICE" ? "INVOICE" : "RECEIPT",
      blNo: entry.bl.blNo,
    });
  }
  return result;
}

/** Opens the email preview: builds the drafts and locks their B/Ls for the actor. */
export function prepareRequestEmails(db: Db, actor: AuthUser, input: { blIds: number[] }, now: Date = new Date()): EmailDraft[] {
  authorize(actor, "request.prepareEmail");
  return db.transaction((tx) => {
    const drafts = buildRequestDrafts(tx, input.blIds, now);
    lockForDraft(tx, actor, input.blIds, now);
    return drafts;
  });
}

export function cancelRequestEmails(db: Db, actor: AuthUser, input: { blIds: number[] }): void {
  authorize(actor, "request.prepareEmail");
  db.transaction((tx) => releaseDraftLocks(tx, actor, input.blIds));
}
