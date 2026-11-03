import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { activeUnitOptions, listAgencies } from "@/server/agencies";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listPaymentsAwaitingBl } from "@/server/payments";
import { CreateBlsScreen } from "./create-bls-screen";

export default async function CreateBlsPage() {
  const { user } = await requireSession();
  if (!can(user, "bl.viewAwaiting").allowed) return <Forbidden />;
  const db = getDb();
  const patterns = Object.fromEntries(listAgencies(db, user).map((a) => [a.id, a.blNumberPatterns]));

  return (
    <>
      <h1 className="text-lg font-semibold">{t("bls.createTitle")}</h1>
      <CreateBlsScreen payments={listPaymentsAwaitingBl(db, user)} patterns={patterns} units={activeUnitOptions(db)} readOnly={!can(user, "bl.create").allowed} />
    </>
  );
}
