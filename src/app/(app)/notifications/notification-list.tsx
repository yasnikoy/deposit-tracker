"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { markReadAction } from "./actions";

type Item = { id: number; text: string; href: string; createdAt: string; read: boolean };

/** Opening a notification marks it read; unread ones stand out. */
export function NotificationList({ items }: { items: Item[] }) {
  const router = useRouter();
  const unread = items.filter((i) => !i.read).length;

  if (items.length === 0) return <p className="text-muted-foreground">{t("notifications.empty")}</p>;
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      {unread > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={async () => {
            await markReadAction({});
            router.refresh();
          }}
        >
          {t("notifications.markAllRead")}
        </Button>
      )}
      <ul className="flex flex-col divide-y rounded-md border" data-testid="notifications">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              onClick={async (event) => {
                if (item.read) return;
                // Marked read first, then the header count is refreshed with the new page.
                event.preventDefault();
                await markReadAction({ ids: [item.id] });
                router.push(item.href);
                router.refresh();
              }}
              className={cn("hover:bg-muted flex flex-col gap-0.5 px-3 py-2", !item.read && "bg-primary/5")}
            >
              <span className={cn("text-sm", !item.read && "font-medium")}>{item.text}</span>
              <span className="text-muted-foreground text-xs">{formatTimestamp(item.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
