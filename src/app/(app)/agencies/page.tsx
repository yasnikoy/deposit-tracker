import { Forbidden } from "@/components/forbidden";
import { OVERRIDABLE_SETTING_KEYS } from "@/domain/settings/definitions";
import { t } from "@/i18n";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import { listAgencies } from "@/server/agencies";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { getSetting } from "@/server/settings";
import { AgenciesScreen } from "./agencies-screen";

export default async function AgenciesPage({ searchParams }: { searchParams: Promise<{ agency?: string }> }) {
  const { user } = await requireSession();
  if (!can(user, "agency.view").allowed) return <Forbidden />;
  const db = getDb();
  const agencyParam = Number((await searchParams).agency);
  const globals = Object.fromEntries(OVERRIDABLE_SETTING_KEYS.map((key) => [key, getSetting(key, {}, db)])) as AgencyOverrides;

  return (
    <>
      <h1 className="text-lg font-semibold">{t("agencies.title")}</h1>
      <AgenciesScreen
        agencies={listAgencies(db, user)}
        globals={globals}
        layout={getTableLayout(db, user.id, "agencies")}
        initialAgencyId={Number.isSafeInteger(agencyParam) && agencyParam > 0 ? agencyParam : null}
        permissions={{
          create: can(user, "agency.create").allowed,
          update: can(user, "agency.update").allowed,
          updateOverrides: can(user, "agency.updateOverrides").allowed,
          updateFormTemplate: can(user, "agency.updateFormTemplate").allowed,
          delete: can(user, "agency.delete").allowed,
        }}
      />
    </>
  );
}
