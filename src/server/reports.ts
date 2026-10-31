import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { businessDaysBetween, istanbulToday } from "@/domain/business-days";
import { agingBuckets, agingReport, agencyScorecard, type AgingBucket, type AgingRow, type ScorecardRow } from "@/domain/reports";
import { authorize, can } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { listAllBls, type BlOverview } from "./bl-overview";
import { loadCalendar } from "./calendar";
import type { DbOrTx } from "./db/client";
import { billsOfLading, deductionTypes, ledgerEntries, refundAllocations, refunds } from "./db/schema";
import { openUnexplained } from "./deductions";
import { countPaymentsAwaitingBl } from "./payments";
import { listRefundsToAllocate, listRefundsWithRemainder } from "./refunds";
import { unprocessedSummary } from "./replies";
import { listDueRequests } from "./requests";
import { getSetting } from "./settings";
import { pendingWriteOffCount } from "./write-offs";

export type Position = BlOverview & {
  open: boolean;
  /** What is still to be collected: the expected amount plus unexplained or disputed deductions; 0 once closed. */
  outstandingMinor: number;
};

/** Every active (not voided) B/L with what is still outstanding on it. */
export function positions(db: DbOrTx, actor: AuthUser, now: Date): Position[] {
  return listAllBls(db, actor, now)
    .filter((bl) => !bl.voidedAt)
    .map((bl) => {
      const open = bl.status !== "COLLECTED";
      const unexplained = bl.status === "DEDUCTION_OPEN" || bl.status === "DISPUTED" ? openUnexplained(db, bl.id).reduce((sum, e) => sum + e.amountMinor, 0) : 0;
      return { ...bl, open, outstandingMinor: open ? bl.expectedMinor + unexplained : 0 };
    });
}

export type CurrencyTotal = { currency: string; amountMinor: number };

function totalsByCurrency(items: { currency: string; amountMinor: number }[]): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amountMinor);
  return [...totals.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((a, b) => a.currency.localeCompare(b.currency));
}

export type AgingReport = { buckets: AgingBucket[]; rows: AgingRow[] };

/** Open deposits by agency and currency, bucketed by business days since payment. */
export function agingReportFor(db: DbOrTx, actor: AuthUser, now: Date = new Date()): AgingReport {
  authorize(actor, "report.view");
  const edges = getSetting("durations.agingBucketEdges", {}, db);
  const items = positions(db, actor, now)
    .filter((p) => p.open && p.outstandingMinor > 0)
    .map((p) => ({ agencyId: p.agencyId, agencyName: p.agencyName, currency: p.currency, outstandingMinor: p.outstandingMinor, daysWaiting: p.daysWaiting ?? 0 }));
  return { buckets: agingBuckets(edges), rows: agingReport(items, edges) };
}

/** Per agency and currency: days to refund, attempts, deduction rates (write-offs separate), open balance. */
export function agencyScorecardFor(db: DbOrTx, actor: AuthUser, now: Date = new Date()): ScorecardRow[] {
  authorize(actor, "report.view");
  const all = positions(db, actor, now);
  const ids = all.map((p) => p.id);
  if (ids.length === 0) return [];
  const calendar = loadCalendar(db);

  // The value date of the latest confirmed refund on each B/L.
  const refundedOn = new Map<number, string>();
  for (const row of db
    .select({ blId: refundAllocations.blId, valueDate: refunds.valueDate })
    .from(refundAllocations)
    .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
    .where(and(eq(refundAllocations.state, "CONFIRMED"), inArray(refundAllocations.blId, ids)))
    .all()) {
    const current = refundedOn.get(row.blId);
    if (!current || row.valueDate > current) refundedOn.set(row.blId, row.valueDate);
  }

  // Deductions in effect per B/L and type: compensating rows carry the negated amount, so the sum nets out.
  const deductions = db
    .select({ blId: ledgerEntries.blId, typeName: deductionTypes.name, code: deductionTypes.code, amountMinor: sql<number>`sum(${ledgerEntries.amountMinor})` })
    .from(ledgerEntries)
    .innerJoin(deductionTypes, eq(deductionTypes.id, ledgerEntries.deductionTypeId))
    .where(and(eq(ledgerEntries.type, "DEDUCTION"), inArray(ledgerEntries.blId, ids)))
    .groupBy(ledgerEntries.blId, deductionTypes.id)
    .all()
    .filter((d) => d.amountMinor !== 0);

  return agencyScorecard(
    all.map((p) => {
      const refundDate = !p.open ? refundedOn.get(p.id) : undefined;
      return {
        agencyId: p.agencyId,
        agencyName: p.agencyName,
        currency: p.currency,
        depositMinor: p.depositMinor,
        outstandingMinor: p.outstandingMinor,
        open: p.open,
        daysToRefund: refundDate ? Math.max(0, businessDaysBetween(p.paidAt, refundDate, calendar)) : null,
        attempts: p.attempts,
        deductions: deductions
          .filter((d) => d.blId === p.id)
          .map((d) => ({ typeName: d.typeName, amountMinor: d.amountMinor, writeOff: d.code === "WRITE_OFF" })),
      };
    }),
  );
}

/** A count on the dashboard; null when the viewer may not open the list it leads to. */
type Count = number | null;

export type DashboardSummary = {
  openBalance: CurrencyTotal[];
  collectedThisMonth: CurrencyTotal[];
  todaysWork: { due: Count; followUps: Count; statements: Count; upcoming: Count; failed: Count };
  pending: {
    paymentsWithoutBl: Count;
    refundsToAllocate: Count;
    unprocessedReplies: { count: number; overdue: number } | null;
    unallocated: { count: number; totals: CurrencyTotal[] } | null;
    writeOffsAwaiting: Count;
  };
  problems: { deductionOpen: Count; disputed: Count };
};

/** The dashboard: money at a glance and the counts of each work list the viewer can open. */
export function dashboardSummary(db: DbOrTx, actor: AuthUser, now: Date = new Date()): DashboardSummary {
  const allowed = (action: Parameters<typeof can>[1]) => can(actor, action).allowed;
  const all = allowed("bl.view") ? positions(db, actor, now) : [];
  const month = istanbulToday(now).slice(0, 7);

  const collectedThisMonth = allowed("bl.view")
    ? totalsByCurrency(
        db
          .select({ currency: refunds.currency, amountMinor: refundAllocations.amountMinor })
          .from(refundAllocations)
          .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
          .innerJoin(billsOfLading, eq(billsOfLading.id, refundAllocations.blId))
          .where(and(eq(refundAllocations.state, "CONFIRMED"), sql`substr(${refunds.valueDate}, 1, 7) = ${month}`, isNull(billsOfLading.voidedAt)))
          .all(),
      )
    : [];

  const due = allowed("request.view") ? listDueRequests(db, actor, now) : null;
  const dueRows = due ? due.DUE.flatMap((g) => g.rows) : [];
  const remainder = allowed("allocation.view") ? listRefundsWithRemainder(db, actor) : null;
  const unprocessed = allowed("reply.view") ? unprocessedSummary(db, now) : null;

  return {
    openBalance: totalsByCurrency(all.filter((p) => p.open).map((p) => ({ currency: p.currency, amountMinor: p.outstandingMinor }))),
    collectedThisMonth,
    todaysWork: {
      due: due ? dueRows.length : null,
      followUps: due ? dueRows.filter((r) => r.type === "REFUND" && r.kind === "FOLLOW_UP").length : null,
      statements: due ? dueRows.filter((r) => r.type === "DEDUCTION_STATEMENT").length : null,
      upcoming: due ? due.UPCOMING.reduce((n, g) => n + g.rows.length, 0) : null,
      failed: due ? due.FAILED.length : null,
    },
    pending: {
      paymentsWithoutBl: allowed("bl.viewAwaiting") ? countPaymentsAwaitingBl(db) : null,
      refundsToAllocate: allowed("allocation.view") ? listRefundsToAllocate(db, actor).length : null,
      unprocessedReplies: unprocessed ? { count: unprocessed.count, overdue: unprocessed.overdue } : null,
      unallocated: remainder ? { count: remainder.length, totals: totalsByCurrency(remainder.map((r) => ({ currency: r.currency, amountMinor: r.remainderMinor }))) } : null,
      writeOffsAwaiting: allowed("writeOff.view") ? pendingWriteOffCount(db) : null,
    },
    problems: {
      deductionOpen: allowed("bl.view") ? all.filter((p) => p.status === "DEDUCTION_OPEN").length : null,
      disputed: allowed("bl.view") ? all.filter((p) => p.status === "DISPUTED").length : null,
    },
  };
}
