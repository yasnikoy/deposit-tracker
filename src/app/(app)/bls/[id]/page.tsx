import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { istanbulToday } from "@/domain/business-days";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getBlDetail } from "@/server/bl-overview";
import { getDb } from "@/server/db/client";
import { listDeductionTypes, listReplyTypes } from "@/server/lists";
import { DomainError } from "@/server/errors";
import { mentionableUsers } from "@/server/notes";
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
        overrides: can(user, "bl.updateOverrides").allowed,
        recordReply: can(user, "reply.record").allowed,
        linkEmail: can(user, "email.link").allowed,
        reverseAllocation: can(user, "allocation.reverse").allowed,
        attachEvidence: !!detail.payment && can(user, "payment.attachEvidence", detail.payment).allowed,
        attachOpeningEvidence: !!detail.openingBalance && can(user, "openingBalance.attachEvidence").allowed,
        recordDeduction: can(user, "deduction.record").allowed,
        disputeDeduction: can(user, "deduction.dispute").allowed,
        proposeWriteOff: can(user, "writeOff.propose").allowed,
        addNote: can(user, "note.add").allowed,
      }}
      mentionable={mentionableUsers(getDb())}
      // Users enter real types; the system types come from allocation and write-off approval.
      deductionTypes={listDeductionTypes(getDb(), user)
        .filter((type) => type.active && type.code === null)
        .map(({ id, name }) => ({ id, name }))}
      replyTypes={listReplyTypes(getDb(), user)
        .filter((type) => type.active)
        .map(({ id, name, code }) => ({ id, name, code }))}
      today={istanbulToday()}
    />
  );
}
