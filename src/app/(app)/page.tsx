import Link from "next/link";
import { redirect } from "next/navigation";
import { t, type TranslationKey } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { takeGettingStarted } from "@/server/preferences";
import { dashboardSummary, type CurrencyTotal } from "@/server/reports";

type Item = { label: TranslationKey; count: number | null; href: string; alert?: boolean; detail?: string };

function Totals({ title, totals }: { title: TranslationKey; totals: CurrencyTotal[] }) {
  return (
    <div className="rounded-md border px-4 py-3">
      <div className="text-muted-foreground text-xs">{t(title)}</div>
      {totals.length === 0 ? (
        <div className="tabular text-lg font-semibold">{t("common.none")}</div>
      ) : (
        totals.map((total) => (
          <div key={total.currency} className="tabular text-lg font-semibold">
            {formatMoney(total.amountMinor, total.currency)}
          </div>
        ))
      )}
    </div>
  );
}

/** A column of counts; each opens the list it counts. Lists the viewer cannot open are left out. */
function Column({ title, items }: { title: TranslationKey; items: Item[] }) {
  const shown = items.filter((item) => item.count !== null);
  if (shown.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="font-semibold">{t(title)}</h2>
      <ul className="flex flex-col">
        {shown.map((item) => (
          <li key={item.label}>
            <Link href={item.href} className="hover:bg-muted flex items-baseline gap-3 rounded-md px-2 py-1.5">
              <span className="flex-1">
                {t(item.label)}
                {item.detail && <span className="text-muted-foreground block text-xs">{item.detail}</span>}
              </span>
              <span className={cn("tabular text-lg font-semibold", item.count === 0 && "text-muted-foreground font-normal", item.alert && "text-destructive")}>{item.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function DashboardPage() {
  const { user } = await requireSession();
  // The first visit opens the getting-started guide once; it stays in the user menu.
  if (takeGettingStarted(getDb(), user)) redirect("/getting-started");
  const summary = dashboardSummary(getDb(), user);
  const { todaysWork: work, pending, problems } = summary;
  const money = (totals: CurrencyTotal[]) => totals.map((x) => formatMoney(x.amountMinor, x.currency)).join(" · ");

  return (
    <>
      <h1 className="text-lg font-semibold">{t("dashboard.title")}</h1>
      <p className="text-muted-foreground">{t("dashboard.welcome", { name: user.displayName })}</p>
      <div className="grid max-w-3xl grid-cols-2 gap-4">
        <Totals title="dashboard.openBalance" totals={summary.openBalance} />
        <Totals title="dashboard.collectedThisMonth" totals={summary.collectedThisMonth} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Column
          title="dashboard.todaysWork"
          items={[
            { label: "dashboard.due", count: work.due, href: "/requests" },
            { label: "dashboard.followUps", count: work.followUps, href: "/requests" },
            { label: "dashboard.statements", count: work.statements, href: "/requests" },
            { label: "dashboard.upcoming", count: work.upcoming, href: "/requests?tab=upcoming" },
            { label: "dashboard.failed", count: work.failed, href: "/requests?tab=failed", alert: (work.failed ?? 0) > 0 },
          ]}
        />
        <Column
          title="dashboard.pending"
          items={[
            { label: "dashboard.paymentsWithoutBl", count: pending.paymentsWithoutBl, href: "/bls/new" },
            { label: "dashboard.refundsToAllocate", count: pending.refundsToAllocate, href: "/allocations" },
            { label: "dashboard.accountingEntries", count: pending.accountingEntries, href: "/accounting?tab=entries" },
            {
              label: "dashboard.unprocessedReplies",
              count: pending.unprocessedReplies?.count ?? null,
              href: "/replies",
              alert: (pending.unprocessedReplies?.overdue ?? 0) > 0,
              detail: pending.unprocessedReplies?.overdue ? t("dashboard.overdueReplies", { count: pending.unprocessedReplies.overdue }) : undefined,
            },
            {
              label: "dashboard.unallocated",
              count: pending.unallocated?.count ?? null,
              href: "/allocations#remainder",
              detail: pending.unallocated?.totals.length ? money(pending.unallocated.totals) : undefined,
            },
            { label: "dashboard.writeOffsAwaiting", count: pending.writeOffsAwaiting, href: "/admin/write-offs" },
          ]}
        />
        <Column
          title="dashboard.problems"
          items={[
            { label: "dashboard.deductionOpen", count: problems.deductionOpen, href: "/bls?status=DEDUCTION_OPEN" },
            { label: "dashboard.disputed", count: problems.disputed, href: "/bls?status=DISPUTED" },
          ]}
        />
      </div>
    </>
  );
}
