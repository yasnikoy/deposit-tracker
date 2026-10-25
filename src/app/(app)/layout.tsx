import { AppHeader, type NavItem } from "@/components/app-shell/app-header";
import { ShortcutsDialog } from "@/components/app-shell/shortcuts-dialog";
import { can } from "@/server/auth/can";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { mailOutages } from "@/server/service-status";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user } = await requireSession();
  // Menu visibility is cosmetic; every page and server function checks can() again.
  const items: (NavItem & { visible: boolean })[] = [
    { href: "/", label: "nav.dashboard", visible: true },
    { href: "/accounting", label: "nav.accounting", visible: can(user, "payment.create").allowed },
    { href: "/requests", label: "nav.dueRequests", visible: can(user, "request.view").allowed },
    { href: "/bls", label: "nav.allBls", visible: can(user, "bl.view").allowed },
    { href: "/bls/new", label: "nav.createBls", visible: can(user, "bl.viewAwaiting").allowed },
    { href: "/agencies", label: "nav.agencies", visible: can(user, "agency.view").allowed },
    { href: "/admin/settings", label: "nav.settings", visible: can(user, "settings.view").allowed },
    { href: "/admin/templates", label: "nav.templates", visible: can(user, "settings.view").allowed },
    { href: "/admin/holidays", label: "nav.holidays", visible: can(user, "holiday.manage").allowed },
    { href: "/admin/lists", label: "nav.lists", visible: can(user, "lists.manage").allowed },
    { href: "/admin/users", label: "nav.users", visible: can(user, "user.list").allowed },
  ];
  const nav: NavItem[] = items.filter((item) => item.visible).map(({ href, label }) => ({ href, label }));
  const outages = mailOutages(getDb());
  const dryRun = getEnv().EMAIL_MODE !== "live";

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader nav={nav} user={{ displayName: user.displayName, roles: user.roles }} />
      {outages.map((outage) => (
        <div key={outage.service} role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t(`mail.outage.${outage.service}`, { since: formatTimestamp(outage.since) })}
        </div>
      ))}
      {dryRun && <div className="bg-muted text-muted-foreground border-b px-4 py-1 text-xs">{t("mail.dryRunBanner")}</div>}
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">{children}</main>
      <ShortcutsDialog />
    </div>
  );
}
