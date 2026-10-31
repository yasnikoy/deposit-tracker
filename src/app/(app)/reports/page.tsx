import { Forbidden } from "@/components/forbidden";
import type { AgingBucket } from "@/domain/reports";
import { t } from "@/i18n";
import { formatAmount } from "@/lib/money";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { agencyScorecardFor, agingReportFor } from "@/server/reports";

const bucketLabel = (bucket: AgingBucket) => (bucket.to === null ? t("reports.aging.bucketOpen", { from: bucket.from }) : t("reports.aging.bucket", { from: bucket.from, to: bucket.to }));
const percent = (rate: number | null) => (rate === null ? "" : `%${(rate * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`);
const decimal = (value: number | null) => (value === null ? "" : value.toLocaleString("tr-TR", { maximumFractionDigits: 1 }));

/** Aging and agency scorecard; computed from the ledger and request history, voided records excluded. */
export default async function ReportsPage() {
  const { user } = await requireSession();
  if (!can(user, "report.view").allowed) return <Forbidden />;
  const db = getDb();
  const aging = agingReportFor(db, user);
  const scorecard = agencyScorecardFor(db, user);
  const cell = "px-3 py-1.5";

  return (
    <>
      <h1 className="text-lg font-semibold">{t("reports.title")}</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("reports.aging.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("reports.aging.hint")}</p>
        {aging.rows.length === 0 ? (
          <p className="text-muted-foreground">{t("reports.aging.empty")}</p>
        ) : (
          <table className="tabular w-full max-w-5xl text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr className="border-b">
                <th className={`${cell} font-normal`}>{t("bls.agency")}</th>
                <th className={`${cell} font-normal`}>{t("bls.currency")}</th>
                {aging.buckets.map((bucket) => (
                  <th key={bucket.from} className={`${cell} text-right font-normal`}>
                    {bucketLabel(bucket)}
                  </th>
                ))}
                <th className={`${cell} text-right font-normal`}>{t("reports.total")}</th>
              </tr>
            </thead>
            <tbody>
              {aging.rows.map((row) => (
                <tr key={`${row.agencyId}/${row.currency}`} className="border-b">
                  <td className={cell}>{row.agencyName}</td>
                  <td className={cell}>{row.currency}</td>
                  {row.buckets.map((tally, i) => (
                    <td key={i} className={`${cell} text-right whitespace-nowrap`}>
                      {tally.count > 0 && (
                        <>
                          {formatAmount(tally.amountMinor)} <span className="text-muted-foreground text-xs">({tally.count})</span>
                        </>
                      )}
                    </td>
                  ))}
                  <td className={`${cell} text-right font-medium whitespace-nowrap`}>
                    {formatAmount(row.total.amountMinor)} <span className="text-muted-foreground text-xs">({row.total.count})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("reports.scorecard.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("reports.scorecard.hint")}</p>
        {scorecard.length === 0 ? (
          <p className="text-muted-foreground">{t("reports.scorecard.empty")}</p>
        ) : (
          <table className="tabular w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr className="border-b">
                <th className={`${cell} font-normal`}>{t("bls.agency")}</th>
                <th className={`${cell} font-normal`}>{t("bls.currency")}</th>
                <th className={`${cell} text-right font-normal`}>{t("reports.scorecard.refunded")}</th>
                <th className={`${cell} text-right font-normal`}>{t("reports.scorecard.avgDays")}</th>
                <th className={`${cell} text-right font-normal`}>{t("reports.scorecard.avgAttempts")}</th>
                <th className={`${cell} font-normal`}>{t("reports.scorecard.deductions")}</th>
                <th className={`${cell} text-right font-normal`}>{t("reports.scorecard.writeOffs")}</th>
                <th className={`${cell} text-right font-normal`}>{t("reports.scorecard.open")}</th>
              </tr>
            </thead>
            <tbody>
              {scorecard.map((row) => (
                <tr key={`${row.agencyId}/${row.currency}`} className="border-b align-top">
                  <td className={cell}>{row.agencyName}</td>
                  <td className={cell}>{row.currency}</td>
                  <td className={`${cell} text-right`}>{row.refundedCount}</td>
                  <td className={`${cell} text-right`}>{decimal(row.avgDaysToRefund)}</td>
                  <td className={`${cell} text-right`}>{decimal(row.avgAttempts)}</td>
                  <td className={cell}>
                    {row.deductions.map((d) => (
                      <div key={d.typeName} className="whitespace-nowrap">
                        {d.typeName}: {formatAmount(d.amountMinor)} <span className="text-muted-foreground text-xs">({percent(d.rate)})</span>
                      </div>
                    ))}
                  </td>
                  <td className={`${cell} text-right whitespace-nowrap`}>
                    {row.writeOff.amountMinor > 0 && (
                      <>
                        {formatAmount(row.writeOff.amountMinor)} <span className="text-muted-foreground text-xs">({percent(row.writeOff.rate)})</span>
                      </>
                    )}
                  </td>
                  <td className={`${cell} text-right whitespace-nowrap`}>
                    {formatAmount(row.openBalanceMinor)} <span className="text-muted-foreground text-xs">({row.openCount})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
