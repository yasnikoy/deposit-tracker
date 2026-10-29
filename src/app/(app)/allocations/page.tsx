import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { listRefundsToAllocate } from "@/server/refunds";
import { RefundsToAllocate } from "./refunds-to-allocate";

export default async function AllocationsPage() {
  const { user } = await requireSession();
  if (!can(user, "allocation.view").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("allocations.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("allocations.hint")}</p>
      <RefundsToAllocate refunds={listRefundsToAllocate(db, user)} layout={getTableLayout(db, user.id, "refunds-to-allocate")} />
    </>
  );
}
