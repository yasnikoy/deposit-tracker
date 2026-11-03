import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { istanbulToday, type IsoDate } from "@/domain/business-days";
import { renderTemplate } from "@/domain/email-templates";
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
import { getSetting } from "./settings";

export type ReportFilters = {
  /** Empty: every agency. */
  agencyIds: number[];
  /** Null: every currency. */
  currency: string | null;
  /** The period of the collected section; required when it is chosen. */
  collectedFrom: IsoDate | null;
  collectedTo: IsoDate | null;
};

export type ReportRequest = { sections: ReportSection[]; filters: ReportFilters };

type BuiltSection = { section: ReportSection; title: string; summary: string[]; grid: Grid; fileName: string };

const money = (minor: number, currency: string) => `${formatAmount(minor)} ${currency}`;
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

/** First and last refund request date (sent or recorded on a portal) per B/L. */
function requestDates(db: DbOrTx, blIds: number[]): Map<number, { first: string; last: string }> {
  const dates = new Map<number, { first: string; last: string }>();
  if (blIds.length === 0) return dates;
  const rows = db
    .select({ blId: requests.blId, requestedOn: requests.requestedOn })
    .from(requests)
    .where(and(inArray(requests.blId, blIds), eq(requests.type, "REFUND"), eq(requests.sendStatus, "SENT")))
    .all();
  for (const { blId, requestedOn } of rows) {
    if (!requestedOn) continue;
    const current = dates.get(blId);
    dates.set(blId, current ? { first: requestedOn < current.first ? requestedOn : current.first, last: requestedOn > current.last ? requestedOn : current.last } : { first: requestedOn, last: requestedOn });
  }
  return dates;
}

function requestedSection(db: DbOrTx, open: Position[]): Omit<BuiltSection, "section" | "fileName"> {
  const items = open.filter((p) => p.attempts > 0);
  const dates = requestDates(db, items.map((p) => p.id));
  return {
    title: t("reports.email.sections.REQUESTED"),
    summary: groupBy(items, (p) => [p.outstandingMinor]).map((g) =>
      t("reports.email.lines.requested", { agency: g.agencyName, currency: g.currency, count: g.count, amount: money(g.amounts[0], g.currency) }),
    ),
    grid: {
      headers: [t("bls.blNo"), t("bls.agency"), t("bls.status"), t("bls.deposit"), t("bls.currency"), t("reports.email.columns.outstanding"), t("reports.email.columns.firstRequest"), t("bls.lastRequestOn"), t("bls.attempts"), t("bls.lastReply")],
      rows: items.map((p) => [
        p.blNo,
        p.agencyName,
        t(`bls.statuses.${p.status}`),
        formatAmount(p.depositMinor),
        p.currency,
        formatAmount(p.outstandingMinor),
        date(dates.get(p.id)?.first ?? null),
        date(dates.get(p.id)?.last ?? null),
        String(p.attempts),
        p.lastReply ? `${p.lastReply.typeName} · ${formatBusinessDate(p.lastReply.repliedOn)}` : "",
      ]),
    },
  };
}

function remainingSection(open: Position[]): Omit<BuiltSection, "section" | "fileName"> {
  const items = open.filter((p) => p.outstandingMinor > 0);
  const byCurrency = groupBy(
    items.map((p) => ({ ...p, agencyName: "" })),
    (p) => [p.outstandingMinor],
  );
  return {
    title: t("reports.email.sections.REMAINING"),
    summary: [
      ...groupBy(items, (p) => [p.outstandingMinor]).map((g) =>
        t("reports.email.lines.remaining", { agency: g.agencyName, currency: g.currency, count: g.count, amount: money(g.amounts[0], g.currency) }),
      ),
      ...byCurrency.map((g) => t("reports.email.lines.total", { currency: g.currency, count: g.count, amount: money(g.amounts[0], g.currency) })),
    ],
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
    title: t("reports.email.collectedTitle", { from: formatBusinessDate(from), to: formatBusinessDate(to) }),
    summary: groupBy(items, (i) => [i.amountMinor, i.deductionMinor, i.writeOffMinor]).map((g) =>
      t("reports.email.lines.collected", {
        agency: g.agencyName,
        currency: g.currency,
        count: g.count,
        amount: money(g.amounts[0], g.currency),
        deductions: money(g.amounts[1], g.currency),
        writeOff: money(g.amounts[2], g.currency),
      }),
    ),
    grid: {
      headers: [t("bls.blNo"), t("bls.agency"), t("bls.currency"), t("bls.deposit"), t("reports.email.columns.collected"), t("reports.email.columns.refundDate"), t("reports.email.columns.deductions"), t("reports.email.columns.writeOff")],
      rows: items.map((i) => [i.blNo, i.agencyName, i.currency, formatAmount(i.depositMinor), formatAmount(i.amountMinor), formatBusinessDate(i.lastDate), formatAmount(i.deductionMinor), formatAmount(i.writeOffMinor)]),
    },
  };
}

const PROBLEM_KINDS = ["DEDUCTION_OPEN", "DISPUTED", "FAILED", "WAITING"] as const;

/** Open and disputed deductions, failed sends, and B/Ls waiting beyond the last aging bucket. */
function problemsSection(db: DbOrTx, open: Position[]): Omit<BuiltSection, "section" | "fileName"> {
  const edges = getSetting("durations.agingBucketEdges", {}, db);
  const longest = edges[edges.length - 1];
  const scoped = new Map(open.map((p) => [p.id, p]));
  type Row = { kind: (typeof PROBLEM_KINDS)[number]; bl: Position; amountMinor: number; detail: string };
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
  const count = (kind: Row["kind"]) => rows.filter((r) => r.kind === kind).length;
  return {
    title: t("reports.email.sections.PROBLEMS"),
    summary: PROBLEM_KINDS.map((kind) => t(`reports.email.lines.problems.${kind}`, { count: count(kind), days: longest })),
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
  if (sections.includes("COLLECTED") && (!filters.collectedFrom || !filters.collectedTo || filters.collectedFrom > filters.collectedTo)) {
    throw new DomainError("reports.email.errors.period");
  }
  const all = positions(db, actor, now).filter(inScope(filters));
  const open = all.filter((p) => p.open);
  const today = istanbulToday(now);
  return REPORT_SECTIONS.filter((s) => sections.includes(s)).map((section) => {
    const built =
      section === "REQUESTED" ? requestedSection(db, open) : section === "REMAINING" ? remainingSection(open) : section === "COLLECTED" ? collectedSection(db, all, filters) : problemsSection(db, open);
    return { ...built, section, summary: built.summary.length > 0 ? built.summary : [t("reports.email.empty")], fileName: `${t(`reports.email.sections.${section}`)} ${today}.csv` };
  });
}

/** Section summaries as plain text: a title line, then one line per agency and currency. */
function summaryText(sections: BuiltSection[]): string {
  return sections.map((s) => [s.title, ...s.summary.map((line) => `• ${line}`)].join("\n")).join("\n\n");
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
  attachments: { fileName: string; rows: number }[];
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
    summary: summaryText(sections),
    attachments: sections.map((s) => ({ fileName: s.fileName, rows: s.grid.rows.length })),
  };
}

export type QueueReportInput = ReportRequest & { to: string[]; cc: string[]; subject: string; intro: string };

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
 * Sends the report: the sections are built again from the current state, each list becomes a
 * CSV attachment, and the email goes through the send job like a request (retries, dry-run,
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
        bodyText: composeBody(tx, input.intro, summaryText(sections)),
        sendStatus: "QUEUED",
        queuedBy: actor.id,
        roleUsed,
        createdAt: at,
      })
      .returning()
      .get();
    for (const section of sections) {
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
        after: { sections: sections.map((s) => s.section), filters: input.filters, to: input.to, cc: input.cc, subject: input.subject },
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
