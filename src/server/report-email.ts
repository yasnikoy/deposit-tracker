import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { istanbulToday, type IsoDate } from "@/domain/business-days";
import { renderTemplate, type EmailTemplateKey } from "@/domain/email-templates";
import { refusedRecipients, REPORT_SECTIONS, type ReportSection } from "@/domain/report-email";
import { t } from "@/i18n";
import { toCsv, type Grid } from "@/lib/csv";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, agencyUnits, deductionTypes, emailAttachments, emails, ledgerEntries, refundAllocations, refunds, reportEmails, requests, users } from "./db/schema";
import { DomainError } from "./errors";
import { getEmailTemplate } from "./email/templates";
import { storeGeneratedDocument } from "./files";
import { enqueueJob } from "./jobs";
import { positions, type Position } from "./reports";
import { failedRequests } from "./requests";
import { transfersInPeriod } from "./transfers";
import { getSetting } from "./settings";

export type ReportFilters = {
  /** Empty: every agency. */
  agencyIds: number[];
  /** Null: every currency. */
  currency: string | null;
  /** The period of the requested section (requests sent then); required when it is chosen. */
  requestedFrom: IsoDate | null;
  requestedTo: IsoDate | null;
  /** The period of the collected section; required when it is chosen. */
  collectedFrom: IsoDate | null;
  collectedTo: IsoDate | null;
  /** The period of the transferred section (by transfer date); required when it is chosen. */
  transferredFrom?: IsoDate | null;
  transferredTo?: IsoDate | null;
};

export type ReportRequest = { sections: ReportSection[]; filters: ReportFilters };

/** `values`: the REPORT_SUMMARY placeholders this section fills. */
type BuiltSection = { section: ReportSection; values: Record<string, string>; grid: Grid; fileName: string };

const count = (n: number) => n.toLocaleString("tr-TR");

/** One line per item from a line template; a section with none says so. */
function lines(db: DbOrTx, key: EmailTemplateKey, items: Record<string, string>[]): string {
  if (items.length === 0) return t("reports.email.empty");
  const template = getEmailTemplate(db, key).body;
  return items.map((values) => renderTemplate(template, values)).join("\n");
}
const date = (value: string | null) => (value ? formatBusinessDate(value) : "");

type Group = { agencyName: string; currency: string; count: number; amounts: number[] };

/** Totals per agency and currency, in report order. */
function groupBy<T extends { agencyName: string; currency: string }>(items: T[], amounts: (item: T) => number[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = `${item.agencyName}/${item.currency}`;
    const group = groups.get(key) ?? { agencyName: item.agencyName, currency: item.currency, count: 0, amounts: [] };
    group.count += 1;
    group.amounts = amounts(item).map((amount, i) => (group.amounts[i] ?? 0) + amount);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.agencyName.localeCompare(b.agencyName, "tr") || a.currency.localeCompare(b.currency));
}

function inScope(filters: ReportFilters) {
  return (item: { agencyId: number; currency: string }) =>
    (filters.agencyIds.length === 0 || filters.agencyIds.includes(item.agencyId)) && (filters.currency === null || item.currency === filters.currency);
}

const periodLabel = (from: string, to: string) => (from === to ? formatBusinessDate(from) : `${formatBusinessDate(from)} – ${formatBusinessDate(to)}`);

/**
 * Refund requests sent in the period (first requests and follow-ups alike, one row each), with
 * each B/L's state now. A resend is no request, so it is not listed; nor are failed sends.
 */
function requestedSection(db: DbOrTx, all: Position[], filters: ReportFilters): Omit<BuiltSection, "section" | "fileName"> {
  const from = filters.requestedFrom!;
  const to = filters.requestedTo!;
  const scoped = new Map(all.map((p) => [p.id, p]));
  const sent = scoped.size
    ? db
        .select({ blId: requests.blId, attemptNo: requests.attemptNo, requestedOn: requests.requestedOn })
        .from(requests)
        .where(
          and(
            inArray(requests.blId, [...scoped.keys()]),
            eq(requests.type, "REFUND"),
            eq(requests.sendStatus, "SENT"),
            gte(requests.requestedOn, from),
            lte(requests.requestedOn, to),
          ),
        )
        .all()
    : [];
  const items = sent
    .map((r) => ({ ...r, bl: scoped.get(r.blId)! }))
    .map((r) => ({ ...r, agencyName: r.bl.agencyName, currency: r.bl.currency }))
    .sort((a, b) => a.requestedOn!.localeCompare(b.requestedOn!) || a.agencyName.localeCompare(b.agencyName, "tr") || a.bl.blNo.localeCompare(b.bl.blNo));
  return {
    values: {
      requested_period: periodLabel(from, to),
      requested_lines: lines(
        db,
        "REPORT_LINE_REQUESTED",
        groupBy(items, (r) => [r.bl.depositMinor]).map((g) => ({ agency: g.agencyName, currency: g.currency, count: count(g.count), amount: formatAmount(g.amounts[0]) })),
      ),
    },
    grid: {
      headers: [t("bls.blNo"), t("bls.agency"), t("reports.email.columns.request"), t("reports.email.columns.requestedOn"), t("bls.status"), t("bls.deposit"), t("bls.currency"), t("reports.email.columns.outstanding"), t("bls.lastReply")],
      rows: items.map(({ bl, attemptNo, requestedOn }) => [
        bl.blNo,
        bl.agencyName,
        t("requests.attemptOf.REFUND", { n: attemptNo }),
        date(requestedOn),
        t(`bls.statuses.${bl.status}`),
        formatAmount(bl.depositMinor),
        bl.currency,
        formatAmount(bl.outstandingMinor),
        bl.lastReply ? `${bl.lastReply.typeName} · ${formatBusinessDate(bl.lastReply.repliedOn)}` : "",
      ]),
    },
  };
}

/** Deposits the agency applied to another B/L instead of refunding them, by transfer date. */
function transferredSection(db: DbOrTx, all: Position[], filters: ReportFilters): Omit<BuiltSection, "section" | "fileName"> {
  const from = filters.transferredFrom!;
  const to = filters.transferredTo!;
  const scoped = new Map(all.map((p) => [p.id, p]));
  // Settled sources are still positions (not voided), so the agency and currency filters apply.
  const items = transfersInPeriod(db, from, to)
    .filter((tr) => scoped.has(tr.sourceBlId))
    .map((tr) => ({ ...tr, agencyName: scoped.get(tr.sourceBlId)!.agencyName }))
    .sort((a, b) => a.transferredOn.localeCompare(b.transferredOn) || a.sourceBlNo.localeCompare(b.sourceBlNo));
  return {
    values: {
      transferred_period: periodLabel(from, to),
      transferred_lines: lines(
        db,
        "REPORT_LINE_TRANSFERRED",
        items.map((tr) => ({ agency: tr.agencyName, from_bl: tr.sourceBlNo, to_bl: tr.targetBlNo, amount: formatAmount(tr.amountMinor), currency: tr.currency, date: formatBusinessDate(tr.transferredOn) })),
      ),
    },
    grid: {
      headers: [t("reports.email.columns.transferredOn"), t("bls.agency"), t("reports.email.columns.fromBl"), t("reports.email.columns.toBl"), t("reports.email.columns.amount"), t("bls.currency"), t("reports.email.columns.by")],
      rows: items.map((tr) => [formatBusinessDate(tr.transferredOn), tr.agencyName, tr.sourceBlNo, tr.targetBlNo, formatAmount(tr.amountMinor), tr.currency, tr.byName ?? ""]),
    },
  };
}

function remainingSection(db: DbOrTx, open: Position[]): Omit<BuiltSection, "section" | "fileName"> {
  const items = open.filter((p) => p.outstandingMinor > 0);
  const byCurrency = groupBy(
    items.map((p) => ({ ...p, agencyName: "" })),
    (p) => [p.outstandingMinor],
  );
  return {
    values: {
      remaining_lines:
        items.length === 0
          ? t("reports.email.empty")
          : [
              lines(db, "REPORT_LINE_REMAINING", groupBy(items, (p) => [p.outstandingMinor]).map((g) => ({ agency: g.agencyName, currency: g.currency, count: count(g.count), amount: formatAmount(g.amounts[0]) }))),
              lines(db, "REPORT_LINE_TOTAL", byCurrency.map((g) => ({ currency: g.currency, count: count(g.count), amount: formatAmount(g.amounts[0]) }))),
            ].join("\n"),
    },
    grid: {
      headers: [t("bls.blNo"), t("bls.agency"), t("bls.status"), t("bls.paidAt"), t("bls.deposit"), t("bls.currency"), t("reports.email.columns.outstanding"), t("bls.daysWaiting")],
      rows: items.map((p) => [
        p.blNo,
        p.agencyName,
        t(`bls.statuses.${p.status}`),
        formatBusinessDate(p.paidAt),
        formatAmount(p.depositMinor),
        p.currency,
        formatAmount(p.outstandingMinor),
        p.daysWaiting === null ? "" : String(p.daysWaiting),
      ]),
    },
  };
}

/** Refunds allocated in the period (by refund value date), per B/L, with the B/L's deductions and write-off. */
function collectedSection(db: DbOrTx, all: Position[], filters: ReportFilters): Omit<BuiltSection, "section" | "fileName"> {
  const from = filters.collectedFrom!;
  const to = filters.collectedTo!;
  const byId = new Map(all.map((p) => [p.id, p]));
  const allocations = db
    .select({ blId: refundAllocations.blId, amountMinor: refundAllocations.amountMinor, valueDate: refunds.valueDate })
    .from(refundAllocations)
    .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
    .where(and(eq(refundAllocations.state, "CONFIRMED"), isNull(refunds.voidedAt), gte(refunds.valueDate, from), lte(refunds.valueDate, to)))
    .all()
    .filter((a) => byId.has(a.blId));
  const collected = new Map<number, { amountMinor: number; lastDate: string }>();
  for (const a of allocations) {
    const current = collected.get(a.blId);
    collected.set(a.blId, { amountMinor: (current?.amountMinor ?? 0) + a.amountMinor, lastDate: current && current.lastDate > a.valueDate ? current.lastDate : a.valueDate });
  }
  const ids = [...collected.keys()];
  // Deductions in effect: compensating rows carry the negated amount, so sums net out.
  const deductions = new Map<number, { deductionMinor: number; writeOffMinor: number }>();
  if (ids.length > 0) {
    for (const row of db
      .select({ blId: ledgerEntries.blId, amountMinor: ledgerEntries.amountMinor, code: deductionTypes.code })
      .from(ledgerEntries)
      .innerJoin(deductionTypes, eq(deductionTypes.id, ledgerEntries.deductionTypeId))
      .where(and(eq(ledgerEntries.type, "DEDUCTION"), inArray(ledgerEntries.blId, ids)))
      .all()) {
      const d = deductions.get(row.blId!) ?? { deductionMinor: 0, writeOffMinor: 0 };
      if (row.code === "WRITE_OFF") d.writeOffMinor += row.amountMinor;
      else d.deductionMinor += row.amountMinor;
      deductions.set(row.blId!, d);
    }
  }
  const items = ids
    .map((id) => ({ ...byId.get(id)!, ...collected.get(id)!, ...(deductions.get(id) ?? { deductionMinor: 0, writeOffMinor: 0 }) }))
    .sort((a, b) => a.lastDate.localeCompare(b.lastDate) || a.blNo.localeCompare(b.blNo));
  return {
    values: {
      collected_period: periodLabel(from, to),
      collected_lines: lines(
        db,
        "REPORT_LINE_COLLECTED",
        groupBy(items, (i) => [i.amountMinor, i.deductionMinor, i.writeOffMinor]).map((g) => ({
          agency: g.agencyName,
          currency: g.currency,
          count: count(g.count),
          amount: formatAmount(g.amounts[0]),
          deductions: formatAmount(g.amounts[1]),
          write_off: formatAmount(g.amounts[2]),
        })),
      ),
    },
    grid: {
      headers: [t("bls.blNo"), t("bls.agency"), t("bls.currency"), t("bls.deposit"), t("reports.email.columns.collected"), t("reports.email.columns.refundDate"), t("reports.email.columns.deductions"), t("reports.email.columns.writeOff")],
      rows: items.map((i) => [i.blNo, i.agencyName, i.currency, formatAmount(i.depositMinor), formatAmount(i.amountMinor), formatBusinessDate(i.lastDate), formatAmount(i.deductionMinor), formatAmount(i.writeOffMinor)]),
    },
  };
}

/** Open and disputed deductions, failed sends, and B/Ls waiting beyond the last aging bucket. */
function problemsSection(db: DbOrTx, open: Position[]): Omit<BuiltSection, "section" | "fileName"> {
  const edges = getSetting("durations.agingBucketEdges", {}, db);
  const longest = edges[edges.length - 1];
  const scoped = new Map(open.map((p) => [p.id, p]));
  type Row = { kind: "DEDUCTION_OPEN" | "DISPUTED" | "FAILED" | "WAITING"; bl: Position; amountMinor: number; detail: string };
  const rows: Row[] = [
    ...open
      .filter((p) => p.status === "DEDUCTION_OPEN" || p.status === "DISPUTED")
      .map((p): Row => ({ kind: p.status as "DEDUCTION_OPEN" | "DISPUTED", bl: p, amountMinor: p.outstandingMinor - p.expectedMinor, detail: "" })),
    ...failedRequests(db)
      .filter((f) => scoped.has(f.blId))
      .map((f): Row => ({ kind: "FAILED", bl: scoped.get(f.blId)!, amountMinor: scoped.get(f.blId)!.outstandingMinor, detail: f.failureReason ?? "" })),
    ...open
      .filter((p) => (p.daysWaiting ?? 0) > longest)
      .sort((a, b) => (b.daysWaiting ?? 0) - (a.daysWaiting ?? 0))
      .map((p): Row => ({ kind: "WAITING", bl: p, amountMinor: p.outstandingMinor, detail: t("reports.email.waitingDays", { days: p.daysWaiting ?? 0 }) })),
  ];
  const of = (kind: Row["kind"]) => count(rows.filter((r) => r.kind === kind).length);
  return {
    values: { deduction_open: of("DEDUCTION_OPEN"), disputed: of("DISPUTED"), failed: of("FAILED"), waiting: of("WAITING"), waiting_days: count(longest) },
    grid: {
      headers: [t("reports.email.columns.problem"), t("bls.blNo"), t("bls.agency"), t("bls.currency"), t("reports.email.columns.amount"), t("reports.email.columns.detail")],
      rows: rows.map((r) => [t(`reports.email.problemKinds.${r.kind}`, { days: longest }), r.bl.blNo, r.bl.agencyName, r.bl.currency, formatAmount(r.amountMinor), r.detail]),
    },
  };
}

/** The chosen sections in a fixed order, built from the state of `now`. */
function buildSections(db: DbOrTx, actor: AuthUser, request: ReportRequest, now: Date): BuiltSection[] {
  const { sections, filters } = request;
  if (sections.length === 0) throw new DomainError("reports.email.errors.noSections");
  const badPeriod = (from: string | null, to: string | null) => !from || !to || from > to;
  if (sections.includes("COLLECTED") && badPeriod(filters.collectedFrom, filters.collectedTo)) throw new DomainError("reports.email.errors.period");
  if (sections.includes("REQUESTED") && badPeriod(filters.requestedFrom, filters.requestedTo)) throw new DomainError("reports.email.errors.period");
  if (sections.includes("TRANSFERRED") && badPeriod(filters.transferredFrom ?? null, filters.transferredTo ?? null)) throw new DomainError("reports.email.errors.period");
  const all = positions(db, actor, now).filter(inScope(filters));
  const open = all.filter((p) => p.open);
  const today = istanbulToday(now);
  return REPORT_SECTIONS.filter((s) => sections.includes(s)).map((section) => {
    const built =
      section === "REQUESTED" ? requestedSection(db, all, filters) : section === "REMAINING" ? remainingSection(db, open) : section === "COLLECTED" ? collectedSection(db, all, filters) : section === "TRANSFERRED" ? transferredSection(db, all, filters) : problemsSection(db, open);
    return { ...built, section, fileName: `${t(`reports.email.sections.${section}`)} ${today}.csv` };
  });
}

/** Section summaries from the REPORT_SUMMARY template: the block of each chosen section is kept. */
function summaryText(db: DbOrTx, sections: BuiltSection[]): string {
  const values = Object.assign({}, ...sections.map((s) => ({ ...s.values, [`${s.section.toLowerCase()}_section`]: "1" })));
  return renderTemplate(getEmailTemplate(db, "REPORT_SUMMARY").body, values).trim();
}

function composeBody(db: DbOrTx, intro: string, summary: string): string {
  const signature = getSetting("email.signature", {}, db).trim();
  return [intro.trim(), summary, signature].filter((part) => part !== "").join("\n\n");
}

export type ReportDraft = {
  to: string[];
  subject: string;
  intro: string;
  /** Added below the intro; not editable. */
  summary: string;
  attachments: { section: ReportSection; fileName: string; rows: number }[];
};

/** The preview: default recipients, subject and intro from the template, and what the sections will say. */
export function reportEmailDraft(db: DbOrTx, actor: AuthUser, request: ReportRequest, now: Date = new Date()): ReportDraft {
  authorize(actor, "report.sendEmail");
  const sections = buildSections(db, actor, request, now);
  const template = getEmailTemplate(db, "REPORT");
  const values = { date: formatBusinessDate(istanbulToday(now)) };
  return {
    to: getSetting("reports.defaultRecipients", {}, db),
    subject: renderTemplate(template.subject, values),
    intro: renderTemplate(template.body, values),
    summary: summaryText(db, sections),
    attachments: sections.map((s) => ({ section: s.section, fileName: s.fileName, rows: s.grid.rows.length })),
  };
}

/** `attachSections`: the sections whose list goes along as a CSV (the preview's ticked attachments). */
export type QueueReportInput = ReportRequest & { to: string[]; cc: string[]; subject: string; intro: string; attachSections: ReportSection[] };

/** Rule: internal recipients only, and never an address an agency receives requests at. */
function checkRecipients(db: DbOrTx, addresses: string[], fromAddress: string): void {
  const agencyAddresses = [
    ...db.select({ to: agencies.toRecipients, cc: agencies.ccRecipients }).from(agencies).all(),
    // Units are agency addresses too.
    ...db.select({ to: agencyUnits.toRecipients, cc: agencyUnits.ccRecipients }).from(agencyUnits).all(),
  ].flatMap((a) => [...a.to, ...a.cc]);
  const refused = refusedRecipients(addresses, { internalDomains: getSetting("reports.internalDomains", {}, db), senderAddress: fromAddress, agencyAddresses });
  if (refused.agency.length > 0) throw new DomainError("reports.email.errors.agency", { addresses: refused.agency.join(", ") });
  if (refused.external.length > 0) throw new DomainError("reports.email.errors.external", { addresses: refused.external.join(", ") });
}

/**
 * Sends the report: the sections are built again from the current state, each list left ticked
 * becomes a CSV attachment, and the email goes through the send job like a request (retries, dry-run,
 * sent-folder copy, .eml kept).
 */
export function queueReportEmail(db: Db, actor: AuthUser, input: QueueReportInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "report.sendEmail");
  return db.transaction((tx) => {
    const fromAddress = getSetting("email.fromAddress", {}, tx);
    if (!fromAddress) throw new DomainError("requests.errors.noSender");
    const recipients = [...new Set([...input.to, ...input.cc])];
    checkRecipients(tx, recipients, fromAddress);
    const sections = buildSections(tx, actor, input, now);

    const at = now.toISOString();
    const email = tx
      .insert(emails)
      .values({
        direction: "OUT",
        agencyId: null,
        messageId: `<${randomUUID()}@${fromAddress.split("@")[1]}>`,
        fromAddress,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        bodyText: composeBody(tx, input.intro, summaryText(tx, sections)),
        sendStatus: "QUEUED",
        queuedBy: actor.id,
        roleUsed,
        createdAt: at,
      })
      .returning()
      .get();
    for (const section of sections.filter((s) => input.attachSections.includes(s.section))) {
      const doc = storeGeneratedDocument(
        tx,
        { kind: "OTHER", originalName: section.fileName, content: Buffer.from(toCsv(section.grid), "utf8"), createdBy: actor.id, ownerType: "email", ownerId: email.id },
        now,
      );
      tx.insert(emailAttachments).values({ emailId: email.id, documentId: doc.id }).run();
    }
    tx.insert(reportEmails).values({ emailId: email.id, sections: sections.map((s) => s.section), filters: input.filters }).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "report.email",
        entityType: "email",
        entityId: email.id,
        after: { sections: sections.map((s) => s.section), filters: input.filters, attachSections: input.attachSections, to: input.to, cc: input.cc, subject: input.subject },
      },
      now,
    );
    enqueueJob(tx, "SEND_EMAIL", { emailId: email.id }, now, now);
    return email.id;
  });
}

export type SentReport = {
  emailId: number;
  createdAt: string;
  to: string[];
  subject: string;
  sections: ReportSection[];
  status: "QUEUED" | "SENT" | "FAILED";
  dryRun: boolean;
  lastError: string | null;
  sentBy: string;
};

const RECENT_REPORTS = 10;

/** The latest report emails with their send status, newest first: a failed send shows here. */
export function listSentReports(db: DbOrTx, actor: AuthUser): SentReport[] {
  authorize(actor, "report.view");
  return db
    .select({ email: emails, sections: reportEmails.sections, sentBy: users.displayName })
    .from(reportEmails)
    .innerJoin(emails, eq(emails.id, reportEmails.emailId))
    .innerJoin(users, eq(users.id, emails.queuedBy))
    .orderBy(desc(emails.id))
    .limit(RECENT_REPORTS)
    .all()
    .map(({ email, sections, sentBy }) => ({
      emailId: email.id,
      createdAt: email.createdAt,
      to: [...email.to, ...email.cc],
      subject: email.subject,
      sections: sections as ReportSection[],
      status: email.sendStatus!,
      dryRun: email.dryRun,
      lastError: email.lastError,
      sentBy,
    }));
}
