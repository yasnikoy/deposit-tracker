import { Forbidden } from "@/components/forbidden";
import { APP_VERSION } from "@/lib/version";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { systemHealth } from "@/server/health";
import { installRoot, updateState } from "@/server/updates";
import { UpdateCard } from "./update-card";
import { SystemScreen } from "./system-screen";

export default async function SystemPage() {
  const { user } = await requireSession();
  if (!can(user, "system.view").allowed) return <Forbidden />;
  return (
    <>
      <h1 className="text-lg font-semibold">{t("system.title")}</h1>
      <SystemScreen health={systemHealth(getDb(), user)} canBackup={can(user, "backup.run").allowed} />
      <div className="mt-4 max-w-4xl">
        <UpdateCard version={APP_VERSION} state={updateState()} installed={installRoot() !== null} canInstall={can(user, "update.install").allowed} />
      </div>
    </>
  );
}
