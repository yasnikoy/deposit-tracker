import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listNotifications, type NotificationItem } from "@/server/notifications";
import { NotificationList } from "./notification-list";

const money = (minor: unknown, currency: unknown) => formatMoney(Number(minor), String(currency));

/** The text of a notification, from what was kept when it happened. */
function text(n: NotificationItem): string {
  const d = n.detail;
  switch (n.kind) {
    case "MENTION":
      return t("notifications.texts.MENTION", { author: String(d.author), blNo: String(d.blNo), excerpt: String(d.excerpt) });
    case "CORRECTION":
      return t("notifications.texts.CORRECTION", {
        actor: String(d.actor),
        blNo: String(d.blNo),
        before: money(d.beforeMinor, d.beforeCurrency),
        after: money(d.afterMinor, d.afterCurrency),
        reason: String(d.reason ?? ""),
      });
    case "UNPROCESSED_REPLY":
      return t("notifications.texts.UNPROCESSED_REPLY", { agency: d.agency ? String(d.agency) : t("notifications.unknownAgency"), subject: String(d.subject) });
    case "WRITE_OFF_PROPOSED":
      return t("notifications.texts.WRITE_OFF_PROPOSED", { actor: String(d.actor), blNo: String(d.blNo), amount: money(d.amountMinor, d.currency), reason: String(d.reason) });
    case "WRITE_OFF_DECIDED":
      return d.decision === "APPROVED"
        ? t("notifications.texts.WRITE_OFF_APPROVED", { actor: String(d.actor), blNo: String(d.blNo), amount: money(d.amountMinor, d.currency) })
        : t("notifications.texts.WRITE_OFF_REJECTED", { actor: String(d.actor), blNo: String(d.blNo), note: String(d.note ?? "") });
    case "NEW_AGENCY":
      return t("notifications.texts.NEW_AGENCY", { actor: String(d.actor), agency: String(d.agency) });
  }
}

/** Where a notification leads. */
function href(n: NotificationItem): string {
  if (n.entityType === "email") return `/replies?email=${n.entityId}`;
  if (n.entityType === "write_off") return "/admin/write-offs";
  if (n.entityType === "agency") return `/agencies?agency=${n.entityId}`;
  return `/bls/${n.entityId}`;
}

export default async function NotificationsPage() {
  const { user } = await requireSession();
  if (!can(user, "notification.view").allowed) return <Forbidden />;
  const items = listNotifications(getDb(), user).map((n) => ({ id: n.id, text: text(n), href: href(n), createdAt: n.createdAt, read: n.read }));
  return (
    <>
      <h1 className="text-lg font-semibold">{t("notifications.title")}</h1>
      <NotificationList items={items} />
    </>
  );
}
