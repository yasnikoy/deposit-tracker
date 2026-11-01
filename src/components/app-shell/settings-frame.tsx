"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SETTINGS_SECTIONS, type NavItem } from "./app-header";

/**
 * On a settings page, the side menu of all settings the user may open, grouped by section;
 * elsewhere the page alone. The items come filtered by the user's roles.
 */
export function SettingsFrame({ items, children }: { items: NavItem[]; children: ReactNode }) {
  const pathname = usePathname();
  const matches = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  if (!items.some((item) => matches(item.href))) return children;
  return (
    <div className="flex items-start gap-6">
      <nav aria-label={t("nav.settings")} className="flex w-52 shrink-0 flex-col gap-4 text-sm">
        {SETTINGS_SECTIONS.map((section) => {
          const inSection = items.filter((item) => item.section === section);
          if (inSection.length === 0) return null;
          return (
            <div key={section} className="flex flex-col gap-0.5">
              <div className="text-muted-foreground px-2 pb-1 text-xs font-medium uppercase">{t(`settingsNav.${section}`)}</div>
              {inSection.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={matches(item.href) ? "page" : undefined}
                  className={cn(
                    "rounded-r-md border-l-2 px-2 py-1",
                    matches(item.href) ? "border-primary bg-muted font-medium" : "hover:bg-muted border-transparent",
                  )}
                >
                  {t(item.label)}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}
