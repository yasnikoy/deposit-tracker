"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { FeedbackItem } from "@/server/feedback";
import { setFeedbackClosedAction } from "../../feedback-actions";

/** Bug reports and feature requests from users, open ones first; an admin closes or reopens each. */
export function FeedbackScreen({ items }: { items: FeedbackItem[] }) {
  const router = useRouter();
  const toggle = async (item: FeedbackItem) => {
    const result = await setFeedbackClosedAction({ id: item.id, closed: item.closedAt === null });
    if (!result.ok) return void toast.error(t(result.error, result.params));
    router.refresh();
  };

  if (items.length === 0) return <p className="text-muted-foreground">{t("feedback.none")}</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-muted-foreground text-left text-xs">
        <tr>
          <th className="px-3 py-1 font-normal">{t("feedback.sentAt")}</th>
          <th className="px-3 py-1 font-normal">{t("feedback.kind")}</th>
          <th className="px-3 py-1 font-normal">{t("feedback.body")}</th>
          <th className="px-3 py-1 font-normal">{t("feedback.page")}</th>
          <th className="px-3 py-1 font-normal">{t("feedback.state")}</th>
          <th className="px-3 py-1 font-normal">{t("common.actions")}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className={item.closedAt ? "text-muted-foreground border-t align-top" : "border-t align-top"}>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {formatTimestamp(item.createdAt)}
              <div className="text-muted-foreground text-xs">{item.byName}</div>
            </td>
            <td className="px-3 py-1.5">{t(`feedback.kinds.${item.kind}`)}</td>
            <td className="px-3 py-1.5 whitespace-pre-line">{item.body}</td>
            <td className="px-3 py-1.5 font-mono text-xs">{item.page ?? t("common.none")}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {item.closedAt ? (
                <>
                  {t("feedback.closed")}
                  <div className="text-xs">
                    {formatTimestamp(item.closedAt)} · {item.closedByName}
                  </div>
                </>
              ) : (
                t("feedback.open")
              )}
            </td>
            <td className="px-3 py-1.5">
              <Button size="sm" variant="outline" onClick={() => toggle(item)}>
                {item.closedAt ? t("feedback.reopen") : t("feedback.close")}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
