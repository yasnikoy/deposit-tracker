import { AppHeader, type NavItem } from "@/components/app-shell/app-header";
import { ShortcutsDialog } from "@/components/app-shell/shortcuts-dialog";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user } = await requireSession();
  // Menu visibility is cosmetic; every page and server function checks can() again.
  const nav: NavItem[] = [
    { href: "/", label: "nav.dashboard" },
    ...(can(user, "user.list").allowed ? [{ href: "/admin/users", label: "nav.users" } as const] : []),
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader nav={nav} user={{ displayName: user.displayName, roles: user.roles }} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">{children}</main>
      <ShortcutsDialog />
    </div>
  );
}
