"use client";

import { Bell, CircleUser, KeyRound, ListChecks, LogOut, MessageSquareWarning, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
import { FeedbackDialog } from "./feedback-dialog";
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The most specific matching item is active, so "/bls/new" does not also light up "/bls".
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const activeHref = nav.filter((item) => matches(item.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const settings = nav.filter((item) => item.section);
  const settingsActive = settings.some((item) => matches(item.href));

  return (
    <header className="bg-background sticky top-0 z-20 flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5">
      <Link href="/" className="font-semibold whitespace-nowrap">
        {t("app.name")} <span className="text-muted-foreground text-xs font-normal">v{version}</span>
      </Link>
      {/* Labels stay on one line; the search box gives way first, then the bar wraps instead of overflowing. */}
      <nav className="flex flex-wrap items-center gap-0.5">
        {nav.filter((item) => !item.section).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) && !settingsActive ? "page" : undefined}
            className={cn(
              "hover:bg-muted rounded-md px-2 py-1 whitespace-nowrap",
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
            className={cn("hover:bg-muted flex items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap", settingsActive && "bg-muted font-medium")}
          >
            <Settings className="size-3.5" />
            {t("nav.settings")}
          </Link>
        )}
      </nav>
      <div className="ml-auto flex min-w-72 flex-1 items-center justify-end gap-2">
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
              <CircleUser /> <span className="max-w-36 truncate">{user.displayName}</span>
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
            <DropdownMenuItem asChild>
              <Link href="/getting-started">
                <ListChecks /> {t("gettingStarted.title")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
              <MessageSquareWarning /> {t("feedback.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => logoutAction()}>
              <LogOut /> {t("nav.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
    </header>
  );
}
