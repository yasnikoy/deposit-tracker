import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { allocationProposal } from "@/server/allocations";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { listDeductionTypes } from "@/server/lists";
import { AllocationReview } from "./allocation-review";

export default async function AllocationReviewPage({ params }: PageProps<"/allocations/[id]">) {
  const { user } = await requireSession();
  if (!can(user, "allocation.view").allowed) return <Forbidden />;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const db = getDb();
  let proposal;
  try {
    proposal = allocationProposal(db, user, id);
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  return (
    <AllocationReview
      proposal={proposal}
      // A write-off is proposed and approved on its own, never chosen as a difference.
      deductionTypes={listDeductionTypes(db, user)
        .filter((d) => d.active && d.code !== "WRITE_OFF")
        .map(({ id, name, code }) => ({ id, name, code }))}
      canConfirm={can(user, "allocation.confirm").allowed}
    />
  );
}
