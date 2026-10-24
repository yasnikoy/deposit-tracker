import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getBlDetail } from "@/server/bl-overview";
import { getDb } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { BlDetailScreen } from "./bl-detail-screen";

export default async function BlDetailPage({ params }: PageProps<"/bls/[id]">) {
  const { user } = await requireSession();
  if (!can(user, "bl.view").allowed) return <Forbidden />;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  let detail;
  try {
    detail = getBlDetail(getDb(), user, id);
  } catch (error) {
    if (error instanceof DomainError && error.messageKey === "errors.notFound") notFound();
    throw error;
  }
  return (
    <BlDetailScreen
      detail={detail}
      can={{
        edit: can(user, "bl.update").allowed,
        void: can(user, "bl.void").allowed,
        forms: can(user, "bl.generateForm").allowed && can(user, "bl.uploadForm").allowed,
      }}
    />
  );
}
