import { t } from "@/i18n";
import { requireSession } from "@/server/auth/current-user";

export default async function DashboardPage() {
  const { user } = await requireSession();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("dashboard.title")}</h1>
      <p>{t("dashboard.welcome", { name: user.displayName })}</p>
      <p className="text-muted-foreground">{t("dashboard.empty")}</p>
    </>
  );
}
