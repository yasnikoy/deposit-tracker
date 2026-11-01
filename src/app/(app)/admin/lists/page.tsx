import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { listCustomers } from "@/server/customers";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { listBankAccounts, listCurrencies, listDeductionTypes, listReplyTypes } from "@/server/lists";
import { CustomersScreen } from "./customers-screen";
import { ListsScreen } from "./lists-screen";

export default async function ListsPage() {
  const { user } = await requireSession();
  if (!can(user, "lists.manage").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("lists.title")}</h1>
      <ListsScreen
        currencies={listCurrencies(db, user)}
        bankAccounts={listBankAccounts(db, user)}
        replyTypes={listReplyTypes(db, user)}
        deductionTypes={listDeductionTypes(db, user)}
      />
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("customers.title")}</h2>
        <p className="text-muted-foreground max-w-3xl text-sm">{t("customers.hint")}</p>
        <CustomersScreen
          customers={listCustomers(db, user).map(({ id, name, code, aliases, active }) => ({ id, name, code, aliases, active }))}
          layout={getTableLayout(db, user.id, "customers")}
          canManage={can(user, "customer.manage").allowed}
        />
      </section>
    </>
  );
}
