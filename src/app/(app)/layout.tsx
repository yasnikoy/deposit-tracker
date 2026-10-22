import { AppHeader, type NavItem } from "@/components/app-shell/app-header";
import { ShortcutsDialog } from "@/components/app-shell/shortcuts-dialog";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user } = await requireSession();
  // Menu visibility is cosmetic; every page and server function checks can() again.
  const items: (NavItem & { visible: boolean })[] = [
    { href: "/", label: "nav.dashboard", visible: true },
    { href: "/accounting", label: "nav.accounting", visible: can(user, "payment.create").allowed },
    { href: "/bls", label: "nav.createBls", visible: can(user, "bl.create").allowed },
    { href: "/agencies", label: "nav.agencies", visible: can(user, "agency.view").allowed },
    { href: "/admin/settings", label: "nav.settings", visible: can(user, "settings.view").allowed },
    { href: "/admin/holidays", label: "nav.holidays", visible: can(user, "holiday.manage").allowed },
    { href: "/admin/lists", label: "nav.lists", visible: can(user, "lists.manage").allowed },
    { href: "/admin/users", label: "nav.users", visible: can(user, "user.list").allowed },
  ];
  const nav: NavItem[] = items.filter((item) => item.visible).map(({ href, label }) => ({ href, label }));

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader nav={nav} user={{ displayName: user.displayName, roles: user.roles }} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">{children}</main>
      <ShortcutsDialog />
    </div>
  );
}
