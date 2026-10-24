import "server-only";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { blBalance, type BlBalance } from "@/domain/balances";
import { displayStatus } from "@/domain/bl-status";
import { businessDaysBetween, istanbulToday, type BusinessCalendar } from "@/domain/business-days";
import type { StoredBlStatus } from "@/domain/bl-lifecycle";
import type { BlStatus, LedgerType, PaymentKind } from "@/domain/records";
import { OVERRIDABLE_SETTING_KEYS, type OverridableSettingKey } from "@/domain/settings/definitions";
import { matchBl, parseBlSearch, type BlMatchField } from "@/lib/bl-search";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { loadCalendar } from "./calendar";
import type { DbOrTx } from "./db/client";
import { agencies, auditLog, billsOfLading, containers, depositPayments, documents, ledgerEntries, users } from "./db/schema";
import { activeLockers } from "./draft-locks";
import { DomainError } from "./errors";
import { currentBlForm } from "./forms";
import { refundRequestStats, timingResolver } from "./requests";
import { getSetting } from "./settings";

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
  const stats = refundRequestStats(db, ids);

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
};

export type BlDocument = { id: number; kind: string; originalName: string; uploadedAt: string; uploadedByName: string };

export type TimelineEvent = {
  id: number;
  at: string;
  action: string;
  actorName: string | null;
  reason: string | null;
  /** System notes shown with the event, e.g. a confirmed duplicate warning or a dry-run send. */
  notes: ("duplicateConfirmed" | "dryRun")[];
};

export type BlDetail = {
  bl: BlOverview;
  payment: { id: number; kind: PaymentKind; evidenceDocumentId: number; evidenceName: string; createdByName: string } | null;
  ledger: BlLedgerLine[];
  documents: BlDocument[];
  timeline: TimelineEvent[];
  /** Request-timing overrides of this B/L, and what each falls back to (agency, then global). */
  overrides: { values: AgencyOverrides; inherited: Record<OverridableSettingKey, number> };
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
          createdByName: users.displayName,
        })
        .from(depositPayments)
        .innerJoin(documents, eq(documents.id, depositPayments.evidenceDocumentId))
        .innerJoin(users, eq(users.id, depositPayments.createdBy))
        .where(eq(depositPayments.id, found.bl.depositPaymentId))
        .get() ?? null)
    : null;

  const ledgerRows = db
    .select({ entry: ledgerEntries, createdByName: users.displayName })
    .from(ledgerEntries)
    .leftJoin(users, eq(users.id, ledgerEntries.createdBy))
    .where(eq(ledgerEntries.blId, id))
    .orderBy(ledgerEntries.id)
    .all();
  const compensatedIds = new Set(ledgerRows.map((r) => r.entry.compensatesEntryId).filter((v) => v !== null));
  const ledger = ledgerRows.map(({ entry, createdByName }) => ({
    id: entry.id,
    type: entry.type,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    entryDate: entry.entryDate,
    compensatesEntryId: entry.compensatesEntryId,
    compensated: compensatedIds.has(entry.id),
    createdAt: entry.createdAt,
    createdByName,
  }));

  const blDocuments = db
    .select({
      id: documents.id,
      kind: documents.kind,
      originalName: documents.originalName,
      uploadedAt: documents.uploadedAt,
      uploadedByName: users.displayName,
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
  const documentIds = [...blDocuments.map((d) => d.id), ...(payment ? [payment.evidenceDocumentId] : [])].map(String);
  if (documentIds.length > 0) {
    entityConditions.push(and(eq(auditLog.entityType, "document"), inArray(auditLog.entityId, documentIds)));
  }
  const timeline = db
    .select({ id: auditLog.id, at: auditLog.at, action: auditLog.action, actorName: users.displayName, reason: auditLog.reason, after: auditLog.after })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(or(...entityConditions))
    .orderBy(auditLog.at, auditLog.id)
    .all()
    .map(({ after, ...event }) => {
      const flags = (after ?? {}) as { duplicateConfirmed?: boolean; dryRun?: boolean };
      const notes: TimelineEvent["notes"] = [];
      if (flags.duplicateConfirmed) notes.push("duplicateConfirmed");
      if (flags.dryRun) notes.push("dryRun");
      return { ...event, notes };
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

  return { bl, payment, ledger, documents: blDocuments, timeline, overrides, form };
}
