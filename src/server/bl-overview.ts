import "server-only";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { blBalance, type BlBalance } from "@/domain/balances";
import { displayStatus } from "@/domain/bl-status";
import { businessDaysBetween, istanbulToday, type BusinessCalendar } from "@/domain/business-days";
import type { StoredBlStatus } from "@/domain/bl-lifecycle";
import type { AllocationState, BlStatus, DeductionSource, DeductionTypeCode, LedgerType, PaymentKind } from "@/domain/records";
import { OVERRIDABLE_SETTING_KEYS, type OverridableSettingKey } from "@/domain/settings/definitions";
import { matchBl, parseBlSearch, type BlMatchField } from "@/lib/bl-search";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { loadCalendar } from "./calendar";
import type { DbOrTx } from "./db/client";
import {
  agencies,
  auditLog,
  billsOfLading,
  containers,
  deductionTypes,
  depositPayments,
  documents,
  emailAttachments,
  emailBlLinks,
  emails,
  ledgerEntries,
  refundAllocations,
  refunds,
  replies,
  replyTypes,
  requests,
  users,
} from "./db/schema";
import { activeLockers } from "./draft-locks";
import { DomainError } from "./errors";
import { currentBlForm } from "./forms";
import { replyHistory } from "./reply-history";
import { requestStats, timingResolver } from "./requests";
import { deductionTarget, type DeductionTarget } from "./deductions";
import { getSetting } from "./settings";
import { undoableAuditIds } from "./undo";
import { blWriteOffs, writeOffAmount, type WriteOffRow } from "./write-offs";

export type BlOverview = BlBalance & {
  id: number;
  blNo: string;
  agencyId: number;
  agencyName: string;
  /** Shown status: DUE is derived on read, never stored. */
  status: BlStatus;
  paidAt: string;
  currency: string;
  containers: string[];
  /** Business days since payment while the B/L is open; null once collected or voided. */
  daysWaiting: number | null;
  /** Another user is drafting a request email for this B/L. */
  lockedBy: string | null;
  /** Refund requests sent or recorded on a portal. */
  attempts: number;
  lastRequestOn: string | null;
  /** The last recorded agency reply (any type). */
  lastReply: { typeName: string; repliedOn: string } | null;
  depositPaymentId: number | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
};

type BlRow = typeof billsOfLading.$inferSelect & { agencyName: string };

function toOverviews(db: DbOrTx, viewer: AuthUser, rows: BlRow[], now: Date): BlOverview[] {
  if (rows.length === 0) return [];
  const lockers = activeLockers(db, viewer, now);
  const ids = rows.map((row) => row.id);
  const calendar: BusinessCalendar = loadCalendar(db);
  const today = istanbulToday(now);
  const timing = timingResolver(db);
  const agencyRows = new Map(db.select().from(agencies).all().map((a) => [a.id, a]));
  const stats = requestStats(db, ids, "REFUND");
  const history = replyHistory(db, ids);

  const entries = db
    .select({ blId: ledgerEntries.blId, type: ledgerEntries.type, amountMinor: ledgerEntries.amountMinor, currency: ledgerEntries.currency })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.blId, ids))
    .all();
  const containerRows = db.select().from(containers).where(inArray(containers.blId, ids)).orderBy(containers.id).all();

  return rows.map((row) => {
    const status = displayStatus(
      { status: row.status as StoredBlStatus, paidAt: row.paidAt, firstRequestDueDays: timing(row, agencyRows.get(row.agencyId)!).firstRequestDueDays },
      today,
      calendar,
    );
    const open = !row.voidedAt && status !== "COLLECTED";
    return {
      ...blBalance(
        entries.filter((e) => e.blId === row.id),
        row.currency,
      ),
      id: row.id,
      blNo: row.blNo,
      agencyId: row.agencyId,
      agencyName: row.agencyName,
      status,
      paidAt: row.paidAt,
      currency: row.currency,
      containers: containerRows.filter((c) => c.blId === row.id).map((c) => c.containerNo),
      daysWaiting: open ? Math.max(0, businessDaysBetween(row.paidAt, today, calendar)) : null,
      lockedBy: lockers.get(row.id) ?? null,
      attempts: stats.get(row.id)?.attempts ?? 0,
      lastRequestOn: stats.get(row.id)?.lastRequestOn ?? null,
      lastReply: history.get(row.id)?.last ?? null,
      depositPaymentId: row.depositPaymentId,
      createdAt: row.createdAt,
      voidedAt: row.voidedAt,
      voidReason: row.voidReason,
    };
  });
}

function blRows(db: DbOrTx) {
  return db
    .select({ bl: billsOfLading, agencyName: agencies.name })
    .from(billsOfLading)
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId));
}

/** Every B/L, voided ones included (the screen filters them), newest payment first. */
export function listAllBls(db: DbOrTx, actor: AuthUser, now: Date = new Date()): BlOverview[] {
  authorize(actor, "bl.view");
  const rows = blRows(db)
    .orderBy(desc(billsOfLading.paidAt), desc(billsOfLading.id))
    .all()
    .map(({ bl, agencyName }) => ({ ...bl, agencyName }));
  return toOverviews(db, actor, rows, now);
}

export type BlSearchResult = {
  items: (Pick<BlOverview, "id" | "blNo" | "agencyName" | "status" | "depositMinor" | "currency" | "containers"> & {
    matched: BlMatchField[];
  })[];
  /** Pasted numbers that matched no B/L. */
  notFound: string[];
  truncated: boolean;
};

export const SEARCH_LIMIT = 50;

/** Header search over active B/Ls: B/L or container number, agency name or deposit amount. */
export function searchBls(db: DbOrTx, actor: AuthUser, query: string, now: Date = new Date()): BlSearchResult {
  authorize(actor, "bl.view");
  const search = parseBlSearch(query);
  if (search.kind === "empty") return { items: [], notFound: [], truncated: false };
  const all = listAllBls(db, actor, now).filter((bl) => !bl.voidedAt);
  const matches = all
    .map((bl) => ({ bl, matched: matchBl({ ...bl, depositAmountMinor: bl.depositMinor }, search) }))
    .filter((m) => m.matched.length > 0);
  const notFound =
    search.kind === "list"
      ? search.numbers.filter((n) => !matches.some(({ bl }) => bl.blNo.toUpperCase() === n || bl.containers.includes(n)))
      : [];
  return {
    items: matches.slice(0, SEARCH_LIMIT).map(({ bl, matched }) => ({
      id: bl.id,
      blNo: bl.blNo,
      agencyName: bl.agencyName,
      status: bl.status,
      depositMinor: bl.depositMinor,
      currency: bl.currency,
      containers: bl.containers,
      matched,
    })),
    notFound,
    truncated: matches.length > SEARCH_LIMIT,
  };
}

export type BlLedgerLine = {
  id: number;
  type: LedgerType;
  amountMinor: number;
  currency: string;
  entryDate: string;
  compensatesEntryId: number | null;
  compensated: boolean;
  createdAt: string;
  createdByName: string | null;
  /** Deductions: type and where it came from (statement, shortfall, write-off), the statement, a dispute. */
  deduction: {
    typeName: string;
    code: DeductionTypeCode | null;
    source: DeductionSource;
    documentId: number | null;
    disputed: boolean;
    disputeNote: string | null;
  } | null;
};

/** A confirmed (or reversed) split of a refund onto this B/L. */
export type BlAllocation = {
  id: number;
  refundId: number;
  amountMinor: number;
  currency: string;
  valueDate: string;
  state: AllocationState;
  confirmedAt: string;
  confirmedByName: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

/** `withdrawn`: an upload taken back by undo; the file stays listed. */
export type BlDocument = { id: number; kind: string; originalName: string; uploadedAt: string; uploadedByName: string; withdrawn: boolean };

/** A message of the B/L's request chain: our sent requests and the agency emails linked to it. */
export type BlEmail = {
  id: number;
  direction: "OUT" | "IN";
  subject: string;
  /** Sent or received. */
  at: string;
  from: string;
  dryRun: boolean;
  attachments: { id: number; originalName: string }[];
};

export type BlReply = { id: number; typeName: string; repliedOn: string; byName: string; emailId: number | null; note: string | null; undone: boolean };

export type TimelineEvent = {
  id: number;
  at: string;
  action: string;
  actorName: string | null;
  reason: string | null;
  /** System notes shown with the event, e.g. a confirmed duplicate warning or a dry-run send. */
  notes: ("duplicateConfirmed" | "dryRun")[];
  /** The viewer can still undo this event (own, undoable, within the window). */
  undoable: boolean;
  /** A later undo took this event back. */
  undone: boolean;
  /** For an undo: the action it took back. */
  undoOfAction: string | null;
};

export type BlDetail = {
  bl: BlOverview;
  /** The source payment; its receipt or invoice may still be missing (rule 12). */
  payment: { id: number; kind: PaymentKind; evidenceDocumentId: number | null; evidenceName: string | null; createdBy: number; createdByName: string } | null;
  ledger: BlLedgerLine[];
  allocations: BlAllocation[];
  documents: BlDocument[];
  emails: BlEmail[];
  replies: BlReply[];
  timeline: TimelineEvent[];
  /** Request-timing overrides of this B/L, and what each falls back to (agency, then global). */
  overrides: { values: AgencyOverrides; inherited: Record<OverridableSettingKey, number> };
  /** Deductions a user can enter now (from a statement, or classifying an unexplained one). */
  deductionTarget: DeductionTarget | null;
  writeOffs: WriteOffRow[];
  /** What a write-off proposed now would cover (what is owed plus unexplained deductions). */
  writeOffAmountMinor: number;
  form: {
    /** Whether the agency has a template, so a prefilled form can be downloaded. */
    templateAvailable: boolean;
    /** The uploaded, signed form that requests attach. */
    current: { id: number; originalName: string; uploadedAt: string } | null;
  };
};

/** Everything the B/L detail shows; voided B/Ls stay readable for their timeline. */
export function getBlDetail(db: DbOrTx, actor: AuthUser, id: number, now: Date = new Date()): BlDetail {
  authorize(actor, "bl.view");
  const found = blRows(db).where(eq(billsOfLading.id, id)).get();
  if (!found) throw new DomainError("errors.notFound");
  const [bl] = toOverviews(db, actor, [{ ...found.bl, agencyName: found.agencyName }], now);

  const payment = found.bl.depositPaymentId
    ? (db
        .select({
          id: depositPayments.id,
          kind: depositPayments.kind,
          evidenceDocumentId: depositPayments.evidenceDocumentId,
          evidenceName: documents.originalName,
          createdBy: depositPayments.createdBy,
          createdByName: users.displayName,
        })
        .from(depositPayments)
        .leftJoin(documents, eq(documents.id, depositPayments.evidenceDocumentId))
        .innerJoin(users, eq(users.id, depositPayments.createdBy))
        .where(eq(depositPayments.id, found.bl.depositPaymentId))
        .get() ?? null)
    : null;

  const ledgerRows = db
    .select({ entry: ledgerEntries, createdByName: users.displayName, deductionTypeName: deductionTypes.name, deductionTypeCode: deductionTypes.code })
    .from(ledgerEntries)
    .leftJoin(users, eq(users.id, ledgerEntries.createdBy))
    .leftJoin(deductionTypes, eq(deductionTypes.id, ledgerEntries.deductionTypeId))
    .where(eq(ledgerEntries.blId, id))
    // Newest first, like every history on the B/L detail.
    .orderBy(desc(ledgerEntries.id))
    .all();
  const compensatedIds = new Set(ledgerRows.map((r) => r.entry.compensatesEntryId).filter((v) => v !== null));
  const ledger = ledgerRows.map(({ entry, createdByName, deductionTypeName, deductionTypeCode }) => ({
    id: entry.id,
    type: entry.type,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    entryDate: entry.entryDate,
    compensatesEntryId: entry.compensatesEntryId,
    compensated: compensatedIds.has(entry.id),
    createdAt: entry.createdAt,
    createdByName,
    deduction:
      deductionTypeName && entry.deductionSource
        ? {
            typeName: deductionTypeName,
            code: deductionTypeCode,
            source: entry.deductionSource,
            documentId: entry.documentId,
            disputed: entry.disputed,
            disputeNote: entry.disputeNote,
          }
        : null,
  }));

  const blDocuments = db
    .select({
      id: documents.id,
      kind: documents.kind,
      originalName: documents.originalName,
      uploadedAt: documents.uploadedAt,
      uploadedByName: users.displayName,
      withdrawn: sql<boolean>`${documents.withdrawnAt} IS NOT NULL`.mapWith(Boolean),
    })
    .from(documents)
    .innerJoin(users, eq(users.id, documents.uploadedBy))
    .where(and(eq(documents.ownerType, "bill_of_lading"), eq(documents.ownerId, id)))
    .orderBy(desc(documents.id))
    .all();

  const entityConditions = [and(eq(auditLog.entityType, "bill_of_lading"), eq(auditLog.entityId, String(id)))];
  if (found.bl.depositPaymentId) {
    entityConditions.push(and(eq(auditLog.entityType, "deposit_payment"), eq(auditLog.entityId, String(found.bl.depositPaymentId))));
  }
  const documentIds = [...blDocuments.map((d) => d.id), ...(payment?.evidenceDocumentId ? [payment.evidenceDocumentId] : [])].map(String);
  if (documentIds.length > 0) {
    entityConditions.push(and(eq(auditLog.entityType, "document"), inArray(auditLog.entityId, documentIds)));
  }
  const timelineRows = db
    .select({ id: auditLog.id, at: auditLog.at, action: auditLog.action, actorName: users.displayName, reason: auditLog.reason, after: auditLog.after, undoOf: auditLog.undoOf })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(or(...entityConditions))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .all()
    .map(({ after, undoOf, ...event }) => {
      const flags = (after ?? {}) as { duplicateConfirmed?: boolean; dryRun?: boolean; undoneAction?: string };
      const notes: TimelineEvent["notes"] = [];
      if (flags.duplicateConfirmed) notes.push("duplicateConfirmed");
      if (flags.dryRun) notes.push("dryRun");
      return { ...event, notes, undoOf, undoOfAction: undoOf !== null ? (flags.undoneAction ?? null) : null };
    });

  const template = db.select({ id: agencies.formTemplateDocumentId }).from(agencies).where(eq(agencies.id, found.bl.agencyId)).get();
  const current = currentBlForm(db, id);
  const form = {
    templateAvailable: template?.id != null,
    current: current ? { id: current.id, originalName: current.originalName, uploadedAt: current.uploadedAt } : null,
  };

  const overrides = {
    values: Object.fromEntries(OVERRIDABLE_SETTING_KEYS.map((key) => [key, found.bl[agencyOverrideFields[key]]])) as AgencyOverrides,
    inherited: Object.fromEntries(
      OVERRIDABLE_SETTING_KEYS.map((key) => [key, getSetting(key, { agencyId: found.bl.agencyId }, db)]),
    ) as Record<OverridableSettingKey, number>,
  };

  const undone = new Set(timelineRows.map((e) => e.undoOf).filter((id) => id !== null));
  const undoable = undoableAuditIds(db, actor, timelineRows.filter((e) => !undone.has(e.id)).map((e) => e.id), now);
  const timeline: TimelineEvent[] = timelineRows.map(({ undoOf: _undoOf, ...event }) => ({ ...event, undoable: undoable.has(event.id), undone: undone.has(event.id) }));

  const allocations = db
    .select({ allocation: refundAllocations, valueDate: refunds.valueDate, currency: refunds.currency, confirmedByName: users.displayName })
    .from(refundAllocations)
    .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
    .innerJoin(users, eq(users.id, refundAllocations.confirmedBy))
    .where(eq(refundAllocations.blId, id))
    .orderBy(desc(refundAllocations.id))
    .all()
    .map(({ allocation, valueDate, currency, confirmedByName }) => ({
      id: allocation.id,
      refundId: allocation.refundId,
      amountMinor: allocation.amountMinor,
      currency,
      valueDate,
      state: allocation.state,
      confirmedAt: allocation.confirmedAt,
      confirmedByName,
      reversedAt: allocation.reversedAt,
      reversalReason: allocation.reversalReason,
    }));

  return {
    bl,
    payment,
    ledger,
    allocations,
    documents: blDocuments,
    emails: blEmails(db, id),
    replies: blReplies(db, id),
    timeline,
    overrides,
    deductionTarget: deductionTarget(db, found.bl),
    writeOffs: blWriteOffs(db, id),
    writeOffAmountMinor: found.bl.voidedAt || found.bl.status === "COLLECTED" ? 0 : writeOffAmount(db, found.bl),
    form,
  };
}

function blEmails(db: DbOrTx, blId: number): BlEmail[] {
  const sentIds = db
    .select({ emailId: requests.emailId })
    .from(requests)
    .where(and(eq(requests.blId, blId), eq(requests.sendStatus, "SENT")))
    .all()
    .map((r) => r.emailId)
    .filter((id): id is number => id !== null);
  const linkedIds = db
    .select({ emailId: emailBlLinks.emailId })
    .from(emailBlLinks)
    .where(and(eq(emailBlLinks.blId, blId), isNull(emailBlLinks.unlinkedAt)))
    .all()
    .map((l) => l.emailId);
  const ids = [...new Set([...sentIds, ...linkedIds])];
  if (ids.length === 0) return [];
  const files = db
    .select({ emailId: emailAttachments.emailId, id: documents.id, originalName: documents.originalName })
    .from(emailAttachments)
    .innerJoin(documents, eq(documents.id, emailAttachments.documentId))
    .where(inArray(emailAttachments.emailId, ids))
    .all();
  return db
    .select()
    .from(emails)
    .where(inArray(emails.id, ids))
    .all()
    .map((email) => ({
      id: email.id,
      direction: email.direction,
      subject: email.subject,
      at: email.receivedAt ?? email.sentAt ?? email.createdAt,
      from: email.fromAddress,
      dryRun: email.dryRun,
      // Our own attachments are the B/L's documents already; the agency's are shown here.
      attachments: email.direction === "IN" ? files.filter((f) => f.emailId === email.id).map(({ id, originalName }) => ({ id, originalName })) : [],
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
}

function blReplies(db: DbOrTx, blId: number): BlReply[] {
  return db
    .select({
      id: replies.id,
      typeName: replyTypes.name,
      repliedOn: replies.repliedOn,
      byName: users.displayName,
      emailId: replies.emailId,
      note: replies.note,
      undone: sql<boolean>`${replies.undoneAt} IS NOT NULL`.mapWith(Boolean),
    })
    .from(replies)
    .innerJoin(replyTypes, eq(replyTypes.id, replies.replyTypeId))
    .innerJoin(users, eq(users.id, replies.createdBy))
    .where(eq(replies.blId, blId))
    .orderBy(desc(replies.repliedOn), desc(replies.id))
    .all();
}
