import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listSettings } from "@/server/settings";
import { listStandingDocuments } from "@/server/standing-documents";
import { SettingsScreen } from "./settings-screen";

export default async function SettingsPage() {
  const { user } = await requireSession();
  if (!can(user, "settings.view").allowed) return <Forbidden />;
  return (
    <>
      <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
      <SettingsScreen settings={listSettings(getDb(), user)} standingDocuments={listStandingDocuments(getDb(), user)} />
    </>
  );
}
