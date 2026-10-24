import { Forbidden } from "@/components/forbidden";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listDueRequests } from "@/server/requests";
import { DueRequestsScreen, type DueTab } from "./due-requests-screen";

export default async function DueRequestsPage({ searchParams }: PageProps<"/requests">) {
  const { user } = await requireSession();
  if (!can(user, "request.view").allowed) return <Forbidden />;
  const tab: DueTab = (await searchParams).tab === "upcoming" ? "UPCOMING" : "DUE";

  return (
    <>
      <h1 className="text-lg font-semibold">{t("requests.title")}</h1>
      <DueRequestsScreen
        tab={tab}
        lists={listDueRequests(getDb(), user)}
        today={istanbulToday()}
        canRecordPortal={can(user, "request.recordPortal").allowed}
        canForms={can(user, "bl.generateForm").allowed && can(user, "bl.uploadForm").allowed}
      />
    </>
  );
}
