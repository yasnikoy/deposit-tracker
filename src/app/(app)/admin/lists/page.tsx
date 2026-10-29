import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listBankAccounts, listCurrencies, listReplyTypes } from "@/server/lists";
import { ListsScreen } from "./lists-screen";

export default async function ListsPage() {
  const { user } = await requireSession();
  if (!can(user, "lists.manage").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("lists.title")}</h1>
      <ListsScreen currencies={listCurrencies(db, user)} bankAccounts={listBankAccounts(db, user)} replyTypes={listReplyTypes(db, user)} />
    </>
  );
}
