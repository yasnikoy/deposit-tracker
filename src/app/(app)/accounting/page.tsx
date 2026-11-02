import { Forbidden } from "@/components/forbidden";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { listAgencies } from "@/server/agencies";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listCurrencies } from "@/server/lists";
import { listPayments, listReceiptQueue } from "@/server/payments";
import { getTableLayout } from "@/server/preferences";
import { listRefunds } from "@/server/refunds";
import { AccountingScreen, type AccountingTab } from "./accounting-screen";
import { listCustomers } from "@/server/customers";
import { listAwaitingAccounting } from "@/server/bl-overview";

const TABS: AccountingTab[] = ["new", "queue", "records", "refund", "refunds", "entries"];

export default async function AccountingPage({ searchParams }: PageProps<"/accounting">) {
  const { user } = await requireSession();
  if (!can(user, "payment.create").allowed) return <Forbidden />;
  const db = getDb();
  const requested = (await searchParams).tab;
  const tab = TABS.find((x) => x === requested) ?? "new";

  return (
    <>
      <h1 className="text-lg font-semibold">{t("nav.accounting")}</h1>
      <AccountingScreen
        tab={tab}
        refs={{
          agencies: listAgencies(db, user).map(({ id, name, bankSenderAliases, blNumberPatterns, active }) => ({
            id,
            name,
            bankSenderAliases,
            blNumberPatterns,
            active,
          })),
          customers: listCustomers(db, user).map(({ id, name, code, aliases, active }) => ({ id, name, code, aliases, active })),
          currencies: listCurrencies(db, user),
          today: istanbulToday(),
        }}
        payments={listPayments(db, user)}
        refunds={listRefunds(db, user)}
        queue={listReceiptQueue(db, user)}
        layout={getTableLayout(db, user.id, "my-payments")}
        refundsLayout={getTableLayout(db, user.id, "my-refunds")}
        canCreateBl={can(user, "bl.create").allowed}
        entries={listAwaitingAccounting(db, user)}
        entriesLayout={getTableLayout(db, user.id, "accounting-entries")}
        currentUserId={user.id}
      />
    </>
  );
}
