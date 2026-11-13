import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listDueRequests } from "@/server/requests";
import { bulkActionOptions } from "../bls/bulk-options";
import { DueRequestsScreen, type DueTab } from "./due-requests-screen";

export default async function DueRequestsPage({ searchParams }: PageProps<"/requests">) {
  const { user } = await requireSession();
  if (!can(user, "request.view").allowed) return <Forbidden />;
  const param = (await searchParams).tab;
  const tab: DueTab = param === "upcoming" ? "UPCOMING" : param === "failed" ? "FAILED" : "DUE";

  return (
    <>
      <h1 className="text-lg font-semibold">{t("requests.title")}</h1>
      <DueRequestsScreen
        tab={tab}
        lists={listDueRequests(getDb(), user)}
        canForms={can(user, "bl.generateForm").allowed && can(user, "bl.uploadForm").allowed}
        canSend={can(user, "request.prepareEmail").allowed && can(user, "request.sendEmail").allowed}
        bulk={bulkActionOptions(getDb(), user)}
      />
    </>
  );
}
