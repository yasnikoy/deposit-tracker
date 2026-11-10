import Link from "next/link";
import { AppHeader, type NavItem } from "@/components/app-shell/app-header";
import { SettingsFrame } from "@/components/app-shell/settings-frame";
import { ShortcutsDialog } from "@/components/app-shell/shortcuts-dialog";
import { can } from "@/server/auth/can";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import { APP_VERSION } from "@/lib/version";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { updateState } from "@/server/updates";
import { unreadNotificationCount } from "@/server/notifications";
import { mailOutages } from "@/server/service-status";
import { pendingWriteOffCount } from "@/server/write-offs";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user } = await requireSession();
  // Menu visibility is cosmetic; every page and server function checks can() again.
  const items: (NavItem & { visible: boolean })[] = [
    { href: "/", label: "nav.dashboard", visible: true },
    { href: "/accounting", label: "nav.accounting", visible: can(user, "payment.create").allowed },
    { href: "/requests", label: "nav.dueRequests", visible: can(user, "request.view").allowed },
    { href: "/allocations", label: "nav.allocations", visible: can(user, "allocation.view").allowed },
    { href: "/bls", label: "nav.allBls", visible: can(user, "bl.view").allowed },
    { href: "/bls/new", label: "nav.createBls", visible: can(user, "bl.viewAwaiting").allowed },
    { href: "/reports", label: "nav.reports", visible: can(user, "report.view").allowed },
    { href: "/admin/write-offs", label: "nav.writeOffs", visible: can(user, "writeOff.view").allowed },
    { href: "/admin/opening-balance", label: "nav.openingBalance", visible: can(user, "openingBalance.create").allowed },
    // Settings: one "Ayarlar" entry for everyone; its side menu shows what the user's roles allow.
    { href: "/settings", label: "nav.personalSettings", section: "personal", visible: true },
    { href: "/agencies", label: "nav.agencies", section: "general", visible: can(user, "agency.view").allowed },
    { href: "/customers", label: "nav.customers", section: "general", visible: can(user, "customer.view").allowed },
    { href: "/admin/settings", label: "nav.appSettings", section: "admin", visible: can(user, "settings.view").allowed },
    { href: "/admin/templates", label: "nav.templates", section: "admin", visible: can(user, "settings.view").allowed },
    { href: "/admin/holidays", label: "nav.holidays", section: "admin", visible: can(user, "holiday.manage").allowed },
    { href: "/admin/lists", label: "nav.lists", section: "admin", visible: can(user, "lists.manage").allowed },
    { href: "/admin/users", label: "nav.users", section: "admin", visible: can(user, "user.list").allowed },
    { href: "/admin/system", label: "nav.system", section: "admin", visible: can(user, "system.view").allowed },
    { href: "/admin/feedback", label: "nav.feedback", section: "admin", visible: can(user, "feedback.manage").allowed },
  ];
  const db = getDb();
  const writeOffsWaiting = can(user, "writeOff.view").allowed ? pendingWriteOffCount(db) : 0;
  const nav: NavItem[] = items
    .filter((item) => item.visible)
    .map(({ visible: _visible, ...item }): NavItem =>
      item.href === "/admin/write-offs" && writeOffsWaiting > 0 ? { ...item, badge: { count: writeOffsWaiting, alert: false, label: "nav.writeOffsBadge" } } : item,
    );
  const outages = mailOutages(db);
  const dryRun = getEnv().EMAIL_MODE !== "live";
  // Admins see a newer release (ARCHITECTURE → Updates); the check runs at start and daily.
  const newVersion = can(user, "system.view").allowed ? (updateState().available?.version ?? null) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader nav={nav} user={{ displayName: user.displayName, roles: user.roles }} version={APP_VERSION} unreadNotifications={unreadNotificationCount(db, user)} />
      {outages.map((outage) => (
        <div key={outage.service} role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t(`mail.outage.${outage.service}`, { since: formatTimestamp(outage.since) })}
        </div>
      ))}
      {dryRun && <div className="bg-muted text-muted-foreground border-b px-4 py-1 text-xs">{t("mail.dryRunBanner")}</div>}
      {newVersion && (
        <div className="border-b bg-sky-50 px-4 py-1 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">
          {t("updates.banner", { version: newVersion })}{" "}
          <Link href="/admin/system" className="underline">
            {t("updates.bannerLink")}
          </Link>
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <SettingsFrame items={nav.filter((item) => item.section)}>{children}</SettingsFrame>
      </main>
      <ShortcutsDialog />
    </div>
  );
}
