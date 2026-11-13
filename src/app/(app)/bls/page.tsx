import { Forbidden } from "@/components/forbidden";
import { BL_STATUSES } from "@/domain/records";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { listAllBls } from "@/server/bl-overview";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { istanbulToday } from "@/domain/business-days";
import { listCustomers } from "@/server/customers";
import { AllBlsScreen } from "./all-bls-screen";
import { bulkActionOptions } from "./bulk-options";

export default async function AllBlsPage({ searchParams }: PageProps<"/bls">) {
  const { user } = await requireSession();
  if (!can(user, "bl.view").allowed) return <Forbidden />;
  const db = getDb();
  const params = await searchParams;
  const requested = params.status;
  const held = params.hold === "1";
  const status = BL_STATUSES.find((s) => s === requested) ?? null;

  return (
    <>
      <h1 className="text-lg font-semibold">{t("bls.allTitle")}</h1>
      {/* A new status link starts the table afresh with that filter. */}
      <AllBlsScreen
        key={`${status ?? ""}${held ? "-held" : ""}`}
        status={status}
        held={held}
        bls={listAllBls(db, user)}
        layout={getTableLayout(db, user.id, "all-bls")}
        canEdit={can(user, "bl.update").allowed}
        canEditDescription={can(user, "bl.editDescription").allowed}
        canVoid={can(user, "bl.void").allowed}
        transfer={
          can(user, "bl.transferDeposit").allowed
            ? {
                customers: listCustomers(db, user).map(({ id, name, code, aliases, active }) => ({ id, name, code, aliases, active })),
                today: istanbulToday(),
              }
            : null
        }
        bulk={bulkActionOptions(db, user)}
      />
    </>
  );
}
