import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listWriteOffs } from "@/server/write-offs";
import { WriteOffsScreen } from "./write-offs-screen";

export default async function WriteOffsPage() {
  const { user } = await requireSession();
  if (!can(user, "writeOff.view").allowed) return <Forbidden />;
  return (
    <>
      <h1 className="text-lg font-semibold">{t("writeOffs.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("writeOffs.hint")}</p>
      <WriteOffsScreen lists={listWriteOffs(getDb(), user)} canDecide={can(user, "writeOff.decide").allowed} />
    </>
  );
}
