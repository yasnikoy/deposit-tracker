import "server-only";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { requestRecipients, type RequestRecipients } from "@/domain/agency";
import { blBalance } from "@/domain/balances";
import { renderTemplate, type EmailTemplateKey } from "@/domain/email-templates";
import type { RequestKind } from "@/domain/due-requests";
import type { RequestType } from "@/domain/records";
import { formatTimestamp } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { unitsByAgency } from "../agencies";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { billsOfLading, containers, customers, emailBlLinks, emails, ledgerEntries, requests } from "../db/schema";
import { DomainError } from "../errors";
import { currentBlForm } from "../forms";
import { dueEntries, type DueEntry } from "../requests";
import { depositEvidences, lacksPaymentEvidence } from "../payments";
import { getSetting } from "../settings";
import { customerStandingDocuments, missingStandingSlots } from "../standing-documents";
import { t } from "@/i18n";
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
  /**
   * B/Ls of a portal agency whose first request this is: it is filed on the portal and this
   * email sends the documents; together they are one request, so sending needs the user to
   * confirm the portal filing.
   */
  portalFiling: string[];
  portalUrl: string | null;
};

/** The first refund request of a portal agency: filed on the portal, documents by this email. */
const isPortalFirst = (entry: DueEntry) => entry.agency.requestChannel === "PORTAL" && entry.state.type === "REFUND" && entry.state.kind === "FIRST";

/**
 * The latest message of a B/L's request chain of one type, to reply to: our last sent request
 * email (or its latest resend), or a later agency email linked to the B/L (for portal agencies, the one linked by
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
  const requested = tx
    .select(fields)
    .from(requests)
    .innerJoin(emails, eq(emails.id, requests.emailId))
    .where(and(eq(requests.blId, blId), eq(requests.type, type), eq(requests.sendStatus, "SENT"), isNotNull(requests.emailId)))
    .orderBy(desc(requests.id))
    .get();
  // A request email sent again (e.g. to the right recipients): the follow-up replies to the resend.
  const resent = requested
    ? tx
        .select(fields)
        .from(emails)
        .where(and(eq(emails.resendOfEmailId, requested.emailId), eq(emails.sendStatus, "SENT")))
        .orderBy(desc(emails.sentAt), desc(emails.id))
        .get()
    : undefined;
  const sent = resent ?? requested;
  const received = tx
    .select(fields)
    .from(emailBlLinks)
    .innerJoin(emails, eq(emails.id, emailBlLinks.emailId))
    .where(and(eq(emailBlLinks.blId, blId), isNull(emailBlLinks.unlinkedAt), eq(emails.direction, "IN")))
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
  const units = unitsByAgency(tx, [...new Set(entries.map((e) => e.agency.id))]);
  // The customer's signature circular and power of attorney go with every request (rule setting).
  const attachStanding = getSetting("rules.attachStandingDocuments", {}, tx);
  const customerIds = [...new Set(entries.map((e) => e.bl.customerId).filter((id): id is number => id !== null))];
  const standing = attachStanding ? customerStandingDocuments(tx, customerIds) : new Map();
  // Where each B/L's request goes: its unit's recipients, or the agency's own list.
  const routes = new Map<number, Extract<RequestRecipients, { ok: true }>>();
  for (const id of unique) {
    const entry = entries.find((e) => e.bl.id === id);
    const blNo = entry?.bl.blNo ?? tx.select({ blNo: billsOfLading.blNo }).from(billsOfLading).where(eq(billsOfLading.id, id)).get()?.blNo;
    if (!blNo) throw new DomainError("errors.notFound");
    if (!entry || entry.state.list === null) throw new DomainError("requests.errors.notDueBl", { bl: blNo });
    const refund = entry.state.type === "REFUND";
    if (refund && formRequired && !currentBlForm(tx, id)) throw new DomainError("requests.errors.formMissing", { bl: blNo });
    const route = requestRecipients(entry.agency, units.get(entry.agency.id) ?? [], entry.bl.unitId);
    if (!route.ok && route.problem === "UNIT_MISSING") throw new DomainError("requests.errors.unitMissing", { bl: blNo });
    if (!route.ok) {
      const unit = units.get(entry.agency.id)?.find((u) => u.id === entry.bl.unitId);
      throw new DomainError("requests.errors.noRecipients", { agency: unit ? `${entry.agency.name} – ${unit.name}` : entry.agency.name });
    }
    routes.set(id, route);
    if (attachStanding) {
      if (entry.bl.customerId === null) throw new DomainError("requests.errors.customerMissing", { bl: blNo });
      const missing = missingStandingSlots(standing.get(entry.bl.customerId));
      if (missing.length > 0) {
        const customer = tx.select({ name: customers.name }).from(customers).where(eq(customers.id, entry.bl.customerId)).get()!.name;
        throw new DomainError("requests.errors.customerDocumentsMissing", { bl: blNo, customer, documents: missing.map((slot) => t(`standing.slots.${slot}`)).join(", ") });
      }
    }
  }

  // Group: agency → (first requests | thread of the follow-up), or one group per B/L.
  const groups = new Map<string, { entries: DueEntry[]; thread: ThreadEmail | null }>();
  for (const entry of entries.sort((a, b) => a.bl.paidAt.localeCompare(b.bl.paidAt) || a.bl.id - b.bl.id)) {
    // A portal agency's first request goes as a reply when the agency already wrote about the B/L.
    const thread = entry.state.kind === "FOLLOW_UP" || isPortalFirst(entry) ? lastThread(tx, entry.bl.id, entry.state.type) : null;
    // Batch emails never mix units (each has its own recipients) nor customers (each sends its own documents).
    const target = `${entry.agency.id}:${routes.get(entry.bl.id)!.unitId ?? "agency"}:${attachStanding ? entry.bl.customerId : "-"}`;
    const key = entry.agency.batchSending
      ? `${target}:${entry.state.kind === "FIRST" && !thread ? "first" : `thread-${thread?.emailId ?? "none"}`}`
      : `${target}:bl-${entry.bl.id}`;
    const group = groups.get(key) ?? { entries: [], thread };
    group.entries.push(entry);
    groups.set(key, group);
  }

  const signature = getSetting("email.signature", {}, tx);
  const defaultCc = getSetting("email.defaultCc", {}, tx);
  const defaultBcc = getSetting("email.defaultBcc", {}, tx);
  const maxAttachmentBytes = getSetting("email.maxAttachmentMb", {}, tx) * 1024 * 1024;

  return [...groups.values()].map(({ entries: group, thread }) => {
    const agency = group[0].agency;
    const route = routes.get(group[0].bl.id)!;
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
    for (const doc of attachStanding ? (standing.get(group[0].bl.customerId!) ?? []) : []) {
      attachments.push({ documentId: doc.documentId, originalName: doc.originalName, sizeBytes: doc.sizeBytes, kind: "STANDING", blNo: null });
    }

    return {
      agencyId: agency.id,
      agencyName: agency.name,
      items: group.map((entry) => ({ blId: entry.bl.id, blNo: entry.bl.blNo, type: entry.state.type, kind: entry.state.kind, attemptNo: entry.state.attemptNo })),
      to: [...route.to],
      cc: [...new Set([...route.cc, ...defaultCc])],
      bcc: defaultBcc,
      subject: thread ? replySubject(thread.subject) : renderTemplate(template.subject, values),
      body: renderTemplate(template.body, values) + (thread ? quoteOf(tx, thread) : ""),
      thread: thread && { emailId: thread.emailId, messageId: thread.messageId, references: thread.references, subject: thread.subject },
      attachments,
      maxAttachmentBytes,
      missingEvidence: group.filter((entry) => lacksPaymentEvidence(tx, entry.bl)).map((entry) => entry.bl.blNo),
      portalFiling: group.filter(isPortalFirst).map((entry) => entry.bl.blNo),
      portalUrl: agency.portalUrl,
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
    deduction_amount: entry.unexplainedMinor === null ? "" : formatAmount(entry.unexplainedMinor),
  };
}

/** Every request attaches the B/L's uploaded form and the deposit receipts (or invoices) of all its payments. */
function blAttachments(tx: DbOrTx, entry: DueEntry): DraftAttachment[] {
  const result: DraftAttachment[] = [];
  const form = currentBlForm(tx, entry.bl.id);
  if (form) result.push({ documentId: form.id, originalName: form.originalName, sizeBytes: form.sizeBytes, kind: "FORM", blNo: entry.bl.blNo });
  for (const evidence of depositEvidences(tx, entry.bl)) {
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
