import "server-only";
import type { AgingBucket, ScorecardRow } from "@/domain/reports";
import { t } from "@/i18n";
import type { Grid } from "@/lib/csv";
import { formatAmount } from "@/lib/money";
import type { AgingReport } from "./reports";

// Report figures as display text, shared by the Reports screen and its CSV downloads.

export const bucketLabel = (bucket: AgingBucket) =>
  bucket.to === null ? t("reports.aging.bucketOpen", { from: bucket.from }) : t("reports.aging.bucket", { from: bucket.from, to: bucket.to });
export const formatRate = (rate: number | null) => (rate === null ? "" : `%${(rate * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`);
export const formatDecimal = (value: number | null) => (value === null ? "" : value.toLocaleString("tr-TR", { maximumFractionDigits: 1 }));

const countOf = (label: string) => t("reports.csv.count", { label });
const rateOf = (label: string) => t("reports.csv.rate", { label });

/** Aging as a grid: per bucket an amount and a B/L count column, so Excel can sum both. */
export function agingGrid(report: AgingReport): Grid {
  const tallyColumns = [...report.buckets.map(bucketLabel), t("reports.total")].flatMap((label) => [label, countOf(label)]);
  return {
    headers: [t("bls.agency"), t("bls.currency"), ...tallyColumns],
    rows: report.rows.map((row) => [
      row.agencyName,
      row.currency,
      ...[...row.buckets, row.total].flatMap((tally) => [formatAmount(tally.amountMinor), String(tally.count)]),
    ]),
  };
}

/** The scorecard as a grid: an amount and a rate column for every deduction type found in any row. */
export function scorecardGrid(rows: readonly ScorecardRow[]): Grid {
  const types = [...new Set(rows.flatMap((row) => row.deductions.map((d) => d.typeName)))].sort((a, b) => a.localeCompare(b, "tr"));
  const writeOff = t("reports.csv.writeOff");
  return {
    headers: [
      t("bls.agency"),
      t("bls.currency"),
      t("reports.scorecard.refunded"),
      t("reports.scorecard.avgDays"),
      t("reports.scorecard.avgAttempts"),
      ...types.flatMap((type) => [type, rateOf(type)]),
      writeOff,
      rateOf(writeOff),
      t("reports.scorecard.open"),
      t("reports.csv.openCount"),
    ],
    rows: rows.map((row) => [
      row.agencyName,
      row.currency,
      String(row.refundedCount),
      formatDecimal(row.avgDaysToRefund),
      formatDecimal(row.avgAttempts),
      ...types.flatMap((type) => {
        const d = row.deductions.find((x) => x.typeName === type);
        return d ? [formatAmount(d.amountMinor), formatRate(d.rate)] : ["", ""];
      }),
      formatAmount(row.writeOff.amountMinor),
      formatRate(row.writeOff.rate),
      formatAmount(row.openBalanceMinor),
      String(row.openCount),
    ]),
  };
}
