import { Forbidden } from "@/components/forbidden";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { listAgencies } from "@/server/agencies";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listCurrencies } from "@/server/lists";
import { OpeningBalanceForm } from "./opening-balance-form";

export default async function OpeningBalancePage() {
  const { user } = await requireSession();
  if (!can(user, "openingBalance.create").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("openingBalances.title")}</h1>
      <p className="text-muted-foreground max-w-3xl text-sm">{t("openingBalances.hint")}</p>
      <OpeningBalanceForm
        refs={{
          agencies: listAgencies(db, user).map(({ id, name, bankSenderAliases, blNumberPatterns, active }) => ({ id, name, bankSenderAliases, blNumberPatterns, active })),
          currencies: listCurrencies(db, user),
          today: istanbulToday(),
        }}
      />
    </>
  );
}
