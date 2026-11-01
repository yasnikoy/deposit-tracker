import Link from "next/link";
import { t } from "@/i18n";
import { requireSession } from "@/server/auth/current-user";
import { listCustomers } from "@/server/customers";
import { getDb } from "@/server/db/client";
import { getCustomerFilter } from "@/server/preferences";
import { CustomerFilterForm } from "./customer-filter-form";

/** Every user's own settings; the side menu adds what their roles allow. */
export default async function PersonalSettingsPage() {
  const { user } = await requireSession();
  const db = getDb();
  const selected = getCustomerFilter(db, user.id);
  // Active customers, plus any followed one deactivated since (so it can be removed).
  const customers = listCustomers(db, user)
    .filter((c) => c.active || selected.includes(c.id))
    .map(({ id, name, code }) => ({ id, name, code }));
  return (
    <>
      <h1 className="text-lg font-semibold">{t("personalSettings.title")}</h1>
      <section className="flex max-w-2xl flex-col gap-2">
        <h2 className="font-semibold">{t("personalSettings.customerFilter")}</h2>
        <p className="text-muted-foreground text-sm">{t("personalSettings.customerFilterHint")}</p>
        <CustomerFilterForm customers={customers} selected={selected} />
      </section>
      <section className="flex max-w-2xl flex-col gap-2">
        <h2 className="font-semibold">{t("personalSettings.password")}</h2>
        <Link href="/change-password" className="self-start underline">
          {t("personalSettings.changePassword")}
        </Link>
      </section>
    </>
  );
}
