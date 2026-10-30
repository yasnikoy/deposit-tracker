"use client";

import { CircleUser, KeyRound, LogOut } from "lucide-react";
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
export type NavItem = { href: string; label: TranslationKey; badge?: { count: number; alert: boolean; label: TranslationKey } };

export function AppHeader({ nav, user, version }: { nav: NavItem[]; user: { displayName: string; roles: Role[] }; version: string }) {
  const pathname = usePathname();
  // The most specific matching item is active, so "/bls/new" does not also light up "/bls".
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const activeHref = nav.filter((item) => matches(item.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;

  return (
    <header className="bg-background sticky top-0 z-20 flex h-11 items-center gap-4 border-b px-4">
      <Link href="/" className="font-semibold whitespace-nowrap">
        {t("app.name")} <span className="text-muted-foreground text-xs font-normal">v{version}</span>
      </Link>
      <nav className="flex items-center gap-1">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? "page" : undefined}
            className={cn(
              "hover:bg-muted rounded-md px-2.5 py-1",
              isActive(item.href) && "bg-muted font-medium",
            )}
          >
            {t(item.label)}
            {item.badge && item.badge.count > 0 && (
              <span
                aria-label={t(item.badge.label, { count: item.badge.count })}
                className={cn(
                  "ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums",
                  item.badge.alert ? "bg-destructive text-white" : "bg-muted-foreground/20",
                )}
              >
                {item.badge.count}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
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
