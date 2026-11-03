import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { listCustomers } from "@/server/customers";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { listCustomerStandingDocuments } from "@/server/standing-documents";
import { CustomersScreen } from "./customers-screen";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const { user } = await requireSession();
  // A notification about a new customer opens its card.
  const customerParam = Number((await searchParams).customer);
  if (!can(user, "customer.view").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("customers.title")}</h1>
      <p className="text-muted-foreground max-w-3xl text-sm">{t("customers.hint")}</p>
      <CustomersScreen
        customers={listCustomers(db, user).map(({ id, name, code, aliases, active }) => ({ id, name, code, aliases, active }))}
        documents={listCustomerStandingDocuments(db, user)}
        initialCustomerId={Number.isSafeInteger(customerParam) && customerParam > 0 ? customerParam : null}
        layout={getTableLayout(db, user.id, "customers")}
        permissions={{ manage: can(user, "customer.manage").allowed, delete: can(user, "customer.delete").allowed, documents: can(user, "standingDocument.manage").allowed }}
      />
    </>
  );
}
