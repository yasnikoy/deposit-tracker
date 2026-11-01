import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { suggestAllocations, type AllocationSuggestions } from "@/domain/allocation";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, statusAfterReversal, type StoredBlStatus } from "@/domain/bl-lifecycle";
import type { ConfirmAllocationInput } from "@/lib/schemas/refunds";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { billsOfLading, customers, deductionTypes, ledgerEntries, refundAllocations, refunds, requests } from "./db/schema";
import { DomainError } from "./errors";
import { activeLedgerEntries, addLedgerEntry, compensateLedgerEntry, reinstateLedgerEntry } from "./ledger";
import { allocatedByRefund, getRefund, type RefundListItem } from "./refunds";
import { getSetting } from "./settings";

/**
 * Statuses that take a refund allocation: a request went out and nothing is settled yet, or a
 * disputed deduction that the agency may still pay.
 */
const ALLOCATABLE: StoredBlStatus[] = ["REQUESTED", "AWAITING_RETURN", "DISPUTED"];

export type CandidateBl = {
  blId: number;
  blNo: string;
  status: StoredBlStatus;
  paidAt: string;
  firstRequestOn: string;
  depositMinor: number;
  deductionsMinor: number;
  collectedMinor: number;
  /** Deposit − recorded deductions − already allocated; for a disputed B/L, the disputed difference. */
  expectedMinor: number;
  /** A disputed B/L: the deduction a payment of the difference cancels. */
  disputedEntryId: number | null;
  customerId: number | null;
  customerName: string | null;
};

/**
 * Rule 2 and ARCHITECTURE → Allocation suggestions: B/Ls of the refund's agency and currency,
 * not voided, still open, with a request sent on or before the value date, and something left
 * to collect. Voided B/Ls and refunds are never candidates.
 */
export function allocationCandidates(tx: DbOrTx, refund: { agencyId: number; currency: string; valueDate: string }): CandidateBl[] {
  const bls = tx
    .select()
    .from(billsOfLading)
    .where(
      and(
        eq(billsOfLading.agencyId, refund.agencyId),
        eq(billsOfLading.currency, refund.currency),
        isNull(billsOfLading.voidedAt),
        inArray(billsOfLading.status, ALLOCATABLE),
      ),
    )
    .all();
  if (bls.length === 0) return [];
  const ids = bls.map((b) => b.id);
  const firstRequests = new Map<number, string>();
  for (const r of tx
    .select({ blId: requests.blId, requestedOn: requests.requestedOn })
    .from(requests)
    .where(and(inArray(requests.blId, ids), eq(requests.sendStatus, "SENT")))
    .all()) {
    const current = firstRequests.get(r.blId);
    if (r.requestedOn && (!current || r.requestedOn < current)) firstRequests.set(r.blId, r.requestedOn);
  }
  const ledger = tx.select().from(ledgerEntries).where(inArray(ledgerEntries.blId, ids)).all();
  const customerNames = new Map(tx.select({ id: customers.id, name: customers.name }).from(customers).all().map((c) => [c.id, c.name]));
  return bls
    .map((bl) => {
      const balance = blBalance(
        ledger.filter((l) => l.blId === bl.id),
        bl.currency,
      );
      // The payment of a disputed difference settles exactly the disputed deduction.
      const disputed = bl.status === "DISPUTED" ? activeLedgerEntries(tx, bl.id, ["DEDUCTION"]).find((e) => e.disputed) : undefined;
      return {
        blId: bl.id,
        blNo: bl.blNo,
        status: bl.status as StoredBlStatus,
        paidAt: bl.paidAt,
        firstRequestOn: firstRequests.get(bl.id) ?? "",
        ...balance,
        expectedMinor: disputed ? disputed.amountMinor : balance.expectedMinor,
        disputedEntryId: disputed?.id ?? null,
        customerId: bl.customerId,
        customerName: bl.customerId === null ? null : (customerNames.get(bl.customerId) ?? null),
      };
    })
    .filter((c) => c.firstRequestOn !== "" && c.firstRequestOn <= refund.valueDate && c.expectedMinor > 0)
    .sort((a, b) => a.firstRequestOn.localeCompare(b.firstRequestOn) || a.blId - b.blId);
}

export type AllocationProposal = {
  refund: RefundListItem;
  /** B/Ls of the refund's customer (all of them for a refund without a customer); suggestions come from these. */
  candidates: CandidateBl[];
  /** Other open B/Ls of the same agency and currency, which a user may still add by hand. */
  otherCandidates: CandidateBl[];
  suggestions: AllocationSuggestions;
};

/** The review screen for one refund: its candidates and the ranked suggestions (never stored). */
export function allocationProposal(db: DbOrTx, actor: AuthUser, refundId: number): AllocationProposal {
  authorize(actor, "allocation.view");
  const refund = getRefund(db, refundId);
  if (refund.voidedAt) throw new DomainError("refunds.errors.voided");
  const all = allocationCandidates(db, refund);
  // Suggestions only from the refund's customer; B/Ls without a customer are not suggested.
  const ofCustomer = (c: CandidateBl) => refund.customerId === null || c.customerId === refund.customerId;
  const candidates = all.filter(ofCustomer);
  const otherCandidates = all.filter((c) => !ofCustomer(c));
  const suggestions = suggestAllocations({
    refundMinor: refund.remainderMinor,
    candidates,
    maxExact: getSetting("reconciliation.alternativeSuggestions", {}, db),
  });
  return { refund, candidates, otherCandidates, suggestions };
}

/**
 * Operations confirms how a refund splits over B/Ls (no auto-confirm, rule 6). A B/L is
 * refunded in one go, so each B/L's amount plus a shortfall it bears must settle what it
 * still expects. The shortfall becomes a deduction of the chosen type; UNEXPLAINED keeps the
 * B/L open (DEDUCTION_OPEN), any other type closes it (rule 1). Allocations never exceed the
 * refund (rule 3); money left over needs a reason.
 */
export function confirmAllocation(db: Db, actor: AuthUser, input: ConfirmAllocationInput, now: Date = new Date()): number[] {
  const roleUsed = authorize(actor, "allocation.confirm")!;
  return db.transaction((tx) => {
    const refund = tx.select().from(refunds).where(eq(refunds.id, input.refundId)).get();
    if (!refund) throw new DomainError("errors.notFound");
    if (refund.voidedAt) throw new DomainError("refunds.errors.voided");
    const remainingMinor = refund.amountMinor - (allocatedByRefund(tx, [refund.id]).get(refund.id) ?? 0);
    if (remainingMinor <= 0) throw new DomainError("allocations.errors.nothingLeft");

    const candidates = new Map(allocationCandidates(tx, refund).map((c) => [c.blId, c]));
    const blIds = input.lines.map((l) => l.blId);
    if (new Set(blIds).size !== blIds.length) throw new DomainError("errors.validation");
    const { shortfall } = input;
    if (shortfall && !blIds.includes(shortfall.blId)) throw new DomainError("allocations.errors.shortfallBl");
    const shortfallType = shortfall ? tx.select().from(deductionTypes).where(eq(deductionTypes.id, shortfall.deductionTypeId)).get() : null;
    if (shortfall && (!shortfallType || !shortfallType.active)) throw new DomainError("allocations.errors.deductionType");
    // A write-off needs an admin approval of its own (rule 16), not a shortfall row.
    if (shortfallType?.code === "WRITE_OFF") throw new DomainError("allocations.errors.writeOff");

    const total = input.lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (total > remainingMinor) throw new DomainError("allocations.errors.exceedsRefund");
    if (total < remainingMinor && !input.remainderReason) throw new DomainError("allocations.errors.remainderReason");

    const at = now.toISOString();
    const ids: number[] = [];
    for (const line of input.lines) {
      const candidate = candidates.get(line.blId);
      if (!candidate) throw new DomainError("allocations.errors.notCandidate");
      const borne = shortfall?.blId === line.blId ? shortfall.amountMinor : 0;
      // A disputed difference is paid in full or not at all; a smaller payment is no settlement.
      if (candidate.disputedEntryId !== null && borne > 0) throw new DomainError("allocations.errors.disputedShortfall", { bl: candidate.blNo });
      if (line.amountMinor + borne !== candidate.expectedMinor) throw new DomainError("allocations.errors.mustSettle", { bl: candidate.blNo });

      const allocation = tx
        .insert(refundAllocations)
        .values({
          refundId: refund.id,
          blId: line.blId,
          amountMinor: line.amountMinor,
          blStatusBefore: candidate.status,
          confirmedBy: actor.id,
          roleUsed,
          confirmedAt: at,
        })
        .returning()
        .get();
      ids.push(allocation.id);
      addLedgerEntry(
        tx,
        { blId: line.blId, type: "REFUND_ALLOCATION", amountMinor: line.amountMinor, currency: refund.currency, entryDate: refund.valueDate, refundAllocationId: allocation.id, createdBy: actor.id },
        now,
      );
      if (borne > 0) {
        addLedgerEntry(
          tx,
          {
            blId: line.blId,
            type: "DEDUCTION",
            amountMinor: borne,
            currency: refund.currency,
            entryDate: refund.valueDate,
            refundAllocationId: allocation.id,
            deduction: { typeId: shortfallType!.id, source: "SHORTFALL" },
            createdBy: actor.id,
          },
          now,
        );
      }

      if (candidate.disputedEntryId !== null) {
        const disputed = activeLedgerEntries(tx, line.blId, ["DEDUCTION"]).find((e) => e.id === candidate.disputedEntryId)!;
        compensateLedgerEntry(tx, disputed, actor.id, now, allocation.id);
      }

      let status: StoredBlStatus;
      try {
        status = nextStatus(
          candidate.status,
          candidate.disputedEntryId !== null
            ? "DIFFERENCE_PAID"
            : shortfallType?.code === "UNEXPLAINED" && borne > 0
              ? "ALLOCATION_UNEXPLAINED"
              : "ALLOCATION_SETTLED",
        );
      } catch (error) {
        if (error instanceof InvalidTransitionError) throw new DomainError("allocations.errors.notCandidate");
        throw error;
      }
      tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, line.blId)).run();
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "allocation.confirm",
          entityType: "bill_of_lading",
          entityId: line.blId,
          before: { status: candidate.status, expectedMinor: candidate.expectedMinor },
          after: {
            status,
            refundId: refund.id,
            allocationId: allocation.id,
            amountMinor: line.amountMinor,
            shortfall: borne > 0 ? { amountMinor: borne, deductionType: shortfallType!.name } : undefined,
            differencePaid: candidate.disputedEntryId !== null || undefined,
          },
        },
        now,
      );
    }
    if (total < remainingMinor) tx.update(refunds).set({ unallocatedReason: input.remainderReason, updatedAt: at }).where(eq(refunds.id, refund.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "refund.allocate",
        entityType: "refund",
        entityId: refund.id,
        after: { allocationIds: ids, allocatedMinor: total, remainderMinor: remainingMinor - total },
        reason: total < remainingMinor ? input.remainderReason : null,
      },
      now,
    );
    return ids;
  });
}

/**
 * Admin only, with a reason (rule 8): the allocation and the shortfall deduction confirmed
 * with it are compensated in the ledger, a disputed deduction it paid is entered again, the
 * B/L returns to its status before the allocation, and the money is open on the refund again.
 * Allocations on one B/L are reversed newest first.
 */
export function reverseAllocation(db: Db, actor: AuthUser, input: { allocationId: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "allocation.reverse");
  db.transaction((tx) => {
    const allocation = tx.select().from(refundAllocations).where(eq(refundAllocations.id, input.allocationId)).get();
    if (!allocation) throw new DomainError("errors.notFound");
    if (allocation.state !== "CONFIRMED") throw new DomainError("allocations.errors.alreadyReversed");
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, allocation.blId)).get()!;
    const later = tx
      .select({ id: refundAllocations.id })
      .from(refundAllocations)
      .where(and(eq(refundAllocations.blId, bl.id), eq(refundAllocations.state, "CONFIRMED"), gt(refundAllocations.id, allocation.id)))
      .get();
    if (later) throw new DomainError("allocations.errors.laterAllocation");
    const at = now.toISOString();

    tx.update(refundAllocations)
      .set({ state: "REVERSED", reversedBy: actor.id, reversedAt: at, reversalReason: input.reason })
      .where(eq(refundAllocations.id, allocation.id))
      .run();
    // Entries this allocation cancelled under its own id: a disputed difference it paid.
    const paidDeductions = tx
      .select({ compensatesEntryId: ledgerEntries.compensatesEntryId })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.blId, bl.id), eq(ledgerEntries.refundAllocationId, allocation.id), isNotNull(ledgerEntries.compensatesEntryId)))
      .all()
      .map((row) => tx.select().from(ledgerEntries).where(eq(ledgerEntries.id, row.compensatesEntryId!)).get()!)
      .filter((original) => original.refundAllocationId !== allocation.id);
    for (const entry of activeLedgerEntries(tx, bl.id).filter((e) => e.refundAllocationId === allocation.id)) {
      compensateLedgerEntry(tx, entry, actor.id, now);
    }
    for (const original of paidDeductions) reinstateLedgerEntry(tx, original, actor.id, now);

    let status: StoredBlStatus;
    try {
      status = statusAfterReversal(bl.status as StoredBlStatus, allocation.blStatusBefore as StoredBlStatus);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("allocations.errors.cannotReverse");
      throw error;
    }
    tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
    // The refund has money to allocate again, so a remainder left on purpose is reopened.
    tx.update(refunds).set({ unallocatedReason: null, updatedAt: at }).where(eq(refunds.id, allocation.refundId)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "allocation.reverse",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status, allocationId: allocation.id, amountMinor: allocation.amountMinor },
        after: { status, refundId: allocation.refundId },
        reason: input.reason,
      },
      now,
    );
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "refund.allocationReversed", entityType: "refund", entityId: allocation.refundId, after: { allocationId: allocation.id }, reason: input.reason },
      now,
    );
  });
}
