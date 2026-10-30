import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listDeductionTypes, listReplyTypes } from "@/server/lists";
import { getTableLayout } from "@/server/preferences";
import { getReplyDetail, listReplies } from "@/server/replies";
import { RepliesScreen, type ReplyTab } from "./replies-screen";

export default async function RepliesPage({ searchParams }: PageProps<"/replies">) {
  const { user } = await requireSession();
  if (!can(user, "reply.view").allowed) return <Forbidden />;
  const db = getDb();
  const params = await searchParams;
  const lists = listReplies(db, user);
  // A link to one email (e.g. from the B/L detail) opens it in the tab that lists it.
  const emailId = Number(params.email);
  const listing = Number.isSafeInteger(emailId) ? (["TO_PROCESS", "MATCHES", "PROCESSED"] as const).find((t) => lists[t].some((r) => r.emailId === emailId)) : undefined;
  const tab: ReplyTab = listing ?? (params.tab === "matches" ? "MATCHES" : params.tab === "processed" ? "PROCESSED" : "TO_PROCESS");

  return (
    <>
      <h1 className="text-lg font-semibold">{t("replies.title")}</h1>
      {/* A new link (another email or tab) starts the screen afresh with that email open. */}
      <RepliesScreen
        key={`${tab}:${listing ? emailId : ""}`}
        tab={tab}
        lists={lists}
        initialDetail={listing ? getReplyDetail(db, user, emailId) : null}
        replyTypes={listReplyTypes(db, user)
          .filter((type) => type.active)
          .map(({ id, name, code }) => ({ id, name, code }))}
        layout={getTableLayout(db, user.id, "replies")}
        canRecord={can(user, "reply.record").allowed}
        canLink={can(user, "email.link").allowed}
        deductionTypes={listDeductionTypes(db, user)
          .filter((type) => type.active && type.code === null)
          .map(({ id, name }) => ({ id, name }))}
        canRecordDeduction={can(user, "deduction.record").allowed}
      />
    </>
  );
}
