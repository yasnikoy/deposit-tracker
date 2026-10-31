import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { systemHealth } from "@/server/health";
import { SystemScreen } from "./system-screen";

export default async function SystemPage() {
  const { user } = await requireSession();
  if (!can(user, "system.view").allowed) return <Forbidden />;
  return (
    <>
      <h1 className="text-lg font-semibold">{t("system.title")}</h1>
      <SystemScreen health={systemHealth(getDb(), user)} canBackup={can(user, "backup.run").allowed} />
    </>
  );
}
