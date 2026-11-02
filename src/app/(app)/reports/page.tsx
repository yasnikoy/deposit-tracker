import { Download } from "lucide-react";
import { Forbidden } from "@/components/forbidden";
import { Button } from "@/components/ui/button";
import { t, type TranslationKey } from "@/i18n";
import { formatAmount } from "@/lib/money";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { bucketLabel, formatDecimal as decimal, formatRate as percent } from "@/server/report-exports";
import { agencyScorecardFor, agingReportFor } from "@/server/reports";
import { listAgencies } from "@/server/agencies";
import { listCurrencies } from "@/server/lists";
import { listSentReports } from "@/server/report-email";
import { istanbulToday } from "@/domain/business-days";
import { formatTimestamp } from "@/lib/format";
import { ReportEmailButton } from "./report-email-dialog";

/** Section title with the CSV download of the same report. */
function ReportHeading({ title, report, empty }: { title: TranslationKey; report: "aging" | "scorecard"; empty: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="font-semibold">{t(title)}</h2>
      {!empty && (
        <Button asChild variant="ghost" size="sm">
          <a href={`/api/reports/${report}`} download>
            <Download /> {t("table.downloadCsv")}
          </a>
        </Button>
      )}
    </div>
  );
}

/** Aging and agency scorecard; computed from the ledger and request history, voided records excluded. */
export default async function ReportsPage() {
  const { user } = await requireSession();
  if (!can(user, "report.view").allowed) return <Forbidden />;
  const db = getDb();
  const aging = agingReportFor(db, user);
  const scorecard = agencyScorecardFor(db, user);
  const sentReports = listSentReports(db, user);
  const today = istanbulToday();
  const cell = "px-3 py-1.5";

  return (
    <>
      {/* Page-level actions sit at the right end of the title row (list screens: of the table toolbar). */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">{t("reports.title")}</h1>
        {can(user, "report.sendEmail").allowed && (
          <ReportEmailButton
            agencies={listAgencies(db, user).map((a) => ({ id: a.id, name: a.name }))}
            currencies={listCurrencies(db, user).map((c) => c.code)}
            period={{ from: `${today.slice(0, 8)}01`, to: today }}
          />
        )}
      </div>

      <section className="flex flex-col gap-2">
        <ReportHeading title="reports.aging.title" report="aging" empty={aging.rows.length === 0} />
        <p className="text-muted-foreground text-sm">{t("reports.aging.hint")}</p>
        {aging.rows.length === 0 ? (
          <p className="text-muted-foreground">{t("reports.aging.empty")}</p>
        ) : (
          <table className="tabular w-full text-sm">
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
                      {tally.count > 0 ? (
                        <>
                          {formatAmount(tally.amountMinor)} <span className="text-muted-foreground text-xs">({tally.count})</span>
                        </>
                      ) : (
                        <Empty />
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
        <ReportHeading title="reports.scorecard.title" report="scorecard" empty={scorecard.length === 0} />
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
                  <td className={`${cell} text-right`}>{decimal(row.avgDaysToRefund) || <Empty />}</td>
                  <td className={`${cell} text-right`}>{decimal(row.avgAttempts) || <Empty />}</td>
                  <td className={cell}>
                    {row.deductions.length === 0 && <Empty />}
                    {row.deductions.map((d) => (
                      <div key={d.typeName} className="whitespace-nowrap">
                        {d.typeName}: {formatAmount(d.amountMinor)} <span className="text-muted-foreground text-xs">({percent(d.rate)})</span>
                      </div>
                    ))}
                  </td>
                  <td className={`${cell} text-right whitespace-nowrap`}>
                    {row.writeOff.amountMinor > 0 ? (
                      <>
                        {formatAmount(row.writeOff.amountMinor)} <span className="text-muted-foreground text-xs">({percent(row.writeOff.rate)})</span>
                      </>
                    ) : (
                      <Empty />
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

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("reports.email.recent")}</h2>
        {sentReports.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("reports.email.recentEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="sent-reports">
            {sentReports.map((report) => (
              <li key={report.emailId} className="flex flex-wrap items-baseline gap-2">
                <span className={report.status === "FAILED" ? "text-destructive font-medium" : "font-medium"}>
                  {t(`reports.email.statuses.${report.status}`)}
                  {report.dryRun && ` (${t("reports.email.dryRun")})`}
                </span>
                <span>{report.subject}</span>
                <span className="text-muted-foreground text-xs">
                  {report.sections.map((s) => t(`reports.email.sections.${s}`)).join(", ")} → {report.to.join(", ")} ·{" "}
                  {t("reports.email.sentBy", { at: formatTimestamp(report.createdAt), user: report.sentBy })}
                </span>
                {report.status === "FAILED" && report.lastError && <span className="text-destructive text-xs">{report.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** An empty report cell: the same "—" as elsewhere in the app. */
function Empty() {
  return <span className="text-muted-foreground">{t("common.none")}</span>;
}
