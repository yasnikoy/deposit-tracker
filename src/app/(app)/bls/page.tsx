import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { listAgencies } from "@/server/agencies";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { listBls } from "@/server/bls";
import { getDb } from "@/server/db/client";
import { listPaymentsAwaitingBl } from "@/server/payments";
import { getTableLayout } from "@/server/preferences";
import { BlsScreen, type BlsTab } from "./bls-screen";

export default async function BlsPage({ searchParams }: PageProps<"/bls">) {
  const { user } = await requireSession();
  if (!can(user, "bl.create").allowed) return <Forbidden />;
  const db = getDb();
  const tab: BlsTab = (await searchParams).tab === "created" ? "created" : "awaiting";
  const patterns = Object.fromEntries(listAgencies(db, user).map((a) => [a.id, a.blNumberPatterns]));

  return (
    <>
      <h1 className="text-lg font-semibold">{t("bls.createTitle")}</h1>
      <BlsScreen
        tab={tab}
        payments={listPaymentsAwaitingBl(db, user)}
        bls={listBls(db, user)}
        patterns={patterns}
        layout={getTableLayout(db, user.id, "created-bls")}
      />
    </>
  );
}
