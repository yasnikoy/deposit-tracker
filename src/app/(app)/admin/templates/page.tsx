import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listEmailTemplates } from "@/server/email/templates";
import { getSetting } from "@/server/settings";
import { TemplatesScreen } from "./templates-screen";

export default async function TemplatesPage() {
  const { user } = await requireSession();
  if (!can(user, "settings.view").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("templates.title")}</h1>
      <TemplatesScreen templates={listEmailTemplates(db, user)} signature={getSetting("email.signature", {}, db)} />
    </>
  );
}
