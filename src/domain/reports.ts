/**
 * Report figures (ARCHITECTURE → Reports and exports), computed from per-B/L facts the server
 * derives from the ledger and request history. Money is summed per currency only; there is no
 * FX conversion, so every row belongs to one agency and one currency.
 */

export type AgingBucket = { from: number; to: number | null };

/** Buckets of business days from the bucket-edge setting: [20, 40, 60] → 0–20, 21–40, 41–60, 61+. */
export function agingBuckets(edges: readonly number[]): AgingBucket[] {
  return [...edges.map((to, i) => ({ from: i === 0 ? 0 : edges[i - 1] + 1, to })), { from: edges[edges.length - 1] + 1, to: null }];
}

export function bucketIndex(days: number, edges: readonly number[]): number {
  const index = edges.findIndex((edge) => days <= edge);
  return index === -1 ? edges.length : index;
}

export type Tally = { count: number; amountMinor: number };

export type AgingItem = { agencyId: number; agencyName: string; currency: string; outstandingMinor: number; daysWaiting: number };
export type AgingRow = { agencyId: number; agencyName: string; currency: string; buckets: Tally[]; total: Tally };

const byAgencyAndCurrency = (a: { agencyName: string; currency: string }, b: { agencyName: string; currency: string }) =>
  a.agencyName.localeCompare(b.agencyName, "tr") || a.currency.localeCompare(b.currency);

/** Open deposits by agency and currency, bucketed by business days since payment. */
export function agingReport(items: readonly AgingItem[], edges: readonly number[]): AgingRow[] {
  const rows = new Map<string, AgingRow>();
  for (const item of items) {
    const key = `${item.agencyId}/${item.currency}`;
    const row = rows.get(key) ?? {
      agencyId: item.agencyId,
      agencyName: item.agencyName,
      currency: item.currency,
      buckets: agingBuckets(edges).map(() => ({ count: 0, amountMinor: 0 })),
      total: { count: 0, amountMinor: 0 },
    };
    const bucket = row.buckets[bucketIndex(item.daysWaiting, edges)];
    bucket.count++;
    bucket.amountMinor += item.outstandingMinor;
    row.total.count++;
    row.total.amountMinor += item.outstandingMinor;
    rows.set(key, row);
  }
  return [...rows.values()].sort(byAgencyAndCurrency);
}

/** One B/L as the scorecard sees it. */
export type ScorecardBl = {
  agencyId: number;
  agencyName: string;
  currency: string;
  depositMinor: number;
  /** What is still to be collected (expected amount plus unexplained deductions); 0 once closed. */
  outstandingMinor: number;
  open: boolean;
  /** Business days from payment to its (last) refund; null when it was closed without a refund. */
  daysToRefund: number | null;
  /** Refund requests sent. */
  attempts: number;
  /** Deductions in effect, by type; write-offs flagged. */
  deductions: { typeName: string; amountMinor: number; writeOff: boolean }[];
};

export type ScorecardRow = {
  agencyId: number;
  agencyName: string;
  currency: string;
  /** Closed B/Ls that received a refund: the base of the averages. */
  refundedCount: number;
  avgDaysToRefund: number | null;
  avgAttempts: number | null;
  /** Deductions of closed B/Ls by type, as a share of their deposits (write-offs separate). */
  deductions: { typeName: string; amountMinor: number; rate: number }[];
  writeOff: { amountMinor: number; rate: number | null };
  openCount: number;
  openBalanceMinor: number;
};

const average = (values: number[]) => (values.length === 0 ? null : Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10);

/** Per agency and currency: average days to refund and attempts, deduction rates, open balance. */
export function agencyScorecard(bls: readonly ScorecardBl[]): ScorecardRow[] {
  const groups = new Map<string, ScorecardBl[]>();
  for (const bl of bls) {
    const key = `${bl.agencyId}/${bl.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), bl]);
  }
  return [...groups.values()]
    .map((group): ScorecardRow => {
      const closed = group.filter((bl) => !bl.open);
      const refunded = closed.filter((bl) => bl.daysToRefund !== null);
      const closedDeposits = closed.reduce((sum, bl) => sum + bl.depositMinor, 0);
      const rate = (amountMinor: number) => (closedDeposits === 0 ? null : amountMinor / closedDeposits);
      const byType = new Map<string, number>();
      let writeOffMinor = 0;
      for (const d of closed.flatMap((bl) => bl.deductions)) {
        if (d.writeOff) writeOffMinor += d.amountMinor;
        else byType.set(d.typeName, (byType.get(d.typeName) ?? 0) + d.amountMinor);
      }
      const open = group.filter((bl) => bl.open);
      return {
        agencyId: group[0].agencyId,
        agencyName: group[0].agencyName,
        currency: group[0].currency,
        refundedCount: refunded.length,
        avgDaysToRefund: average(refunded.map((bl) => bl.daysToRefund!)),
        avgAttempts: average(refunded.map((bl) => bl.attempts)),
        deductions: [...byType.entries()]
          .map(([typeName, amountMinor]) => ({ typeName, amountMinor, rate: rate(amountMinor)! }))
          .sort((a, b) => b.amountMinor - a.amountMinor || a.typeName.localeCompare(b.typeName, "tr")),
        writeOff: { amountMinor: writeOffMinor, rate: rate(writeOffMinor) },
        openCount: open.length,
        openBalanceMinor: open.reduce((sum, bl) => sum + bl.outstandingMinor, 0),
      };
    })
    .sort(byAgencyAndCurrency);
}
