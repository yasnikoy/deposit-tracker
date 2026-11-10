import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listFeedback } from "@/server/feedback";
import { FeedbackScreen } from "./feedback-screen";

export default async function FeedbackPage() {
  const { user } = await requireSession();
  if (!can(user, "feedback.manage").allowed) return <Forbidden />;
  return (
    <>
      <h1 className="text-lg font-semibold">{t("nav.feedback")}</h1>
      <p className="text-muted-foreground text-sm">{t("feedback.listHint")}</p>
      <FeedbackScreen items={listFeedback(getDb(), user)} />
    </>
  );
}
