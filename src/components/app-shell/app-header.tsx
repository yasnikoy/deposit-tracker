"use client";

import { Bell, CircleUser, KeyRound, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/domain/roles";
import { t, type TranslationKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "./global-search";

/** A badge count on the item; `alert` marks it as needing attention (e.g. overdue replies); `label` is read out. */
export type NavItem = {
  href: string;
  label: TranslationKey;
  badge?: { count: number; alert: boolean; label: TranslationKey };
  /** Set for settings pages: they sit behind the one "Ayarlar" entry, grouped in its side menu. */
  section?: SettingsSection;
};

export const SETTINGS_SECTIONS = ["personal", "general", "admin"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

function Badge({ badge }: { badge: NavItem["badge"] }) {
  if (!badge || badge.count === 0) return null;
  return (
    <span
      aria-label={t(badge.label, { count: badge.count })}
      className={cn(
        "ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums",
        badge.alert ? "bg-destructive text-white" : "bg-muted-foreground/20",
      )}
    >
      {badge.count}
    </span>
  );
}

export function AppHeader({
  nav,
  user,
  version,
  unreadNotifications,
}: {
  nav: NavItem[];
  user: { displayName: string; roles: Role[] };
  version: string;
  unreadNotifications: number;
}) {
  const pathname = usePathname();
  // The most specific matching item is active, so "/bls/new" does not also light up "/bls".
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const activeHref = nav.filter((item) => matches(item.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const settings = nav.filter((item) => item.section);
  const settingsActive = settings.some((item) => matches(item.href));

  return (
    <header className="bg-background sticky top-0 z-20 flex h-11 items-center gap-4 border-b px-4">
      <Link href="/" className="font-semibold whitespace-nowrap">
        {t("app.name")} <span className="text-muted-foreground text-xs font-normal">v{version}</span>
      </Link>
      <nav className="flex items-center gap-1">
        {nav.filter((item) => !item.section).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) && !settingsActive ? "page" : undefined}
            className={cn(
              "hover:bg-muted rounded-md px-2.5 py-1",
              isActive(item.href) && !settingsActive && "bg-muted font-medium",
            )}
          >
            {t(item.label)}
            <Badge badge={item.badge} />
          </Link>
        ))}
        {settings.length > 0 && (
          <Link
            href="/settings"
            aria-current={settingsActive ? "page" : undefined}
            className={cn("hover:bg-muted flex items-center gap-1 rounded-md px-2.5 py-1", settingsActive && "bg-muted font-medium")}
          >
            <Settings className="size-3.5" />
            {t("nav.settings")}
          </Link>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
        <Link
          href="/notifications"
          aria-label={t("nav.notifications")}
          title={t("nav.notifications")}
          aria-current={pathname === "/notifications" ? "page" : undefined}
          className={cn("hover:bg-muted flex items-center rounded-md px-2 py-1", pathname === "/notifications" && "bg-muted")}
        >
          <Bell className="size-4" />
          <Badge badge={{ count: unreadNotifications, alert: true, label: "notifications.badge" }} />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <CircleUser /> {user.displayName}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="font-medium">{user.displayName}</div>
              <div className="text-muted-foreground text-xs">{user.roles.map((role) => t(`roles.${role}`)).join(", ")}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/change-password">
                <KeyRound /> {t("nav.changePassword")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => logoutAction()}>
              <LogOut /> {t("nav.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
