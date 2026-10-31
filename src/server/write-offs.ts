import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday } from "@/domain/business-days";
import type { WriteOffState } from "@/domain/records";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, billsOfLading, deductionTypes, users, writeOffs } from "./db/schema";
import { blLedgerBalance, openUnexplained } from "./deductions";
import { DomainError } from "./errors";
import { addLedgerEntry, compensateLedgerEntry } from "./ledger";
import { notify, usersWithRole } from "./notifications";

type BlRow = typeof billsOfLading.$inferSelect;

const OPEN: readonly StoredBlStatus[] = ["PAID", "REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN", "DISPUTED"];

/**
 * What a write-off would cover: what the agency still owes plus the unexplained (or
 * disputed) deductions, which the write-off replaces.
 */
export function writeOffAmount(tx: DbOrTx, bl: BlRow): number {
  const unexplained = openUnexplained(tx, bl.id).reduce((sum, e) => sum + e.amountMinor, 0);
  return blLedgerBalance(tx, bl).expectedMinor + unexplained;
}

/** The open proposal of a B/L, if any. */
export function pendingWriteOff(tx: DbOrTx, blId: number) {
  return tx.select().from(writeOffs).where(and(eq(writeOffs.blId, blId), eq(writeOffs.state, "PROPOSED"))).get() ?? null;
}

/** Proposals waiting for an admin, for the menu badge. */
export function pendingWriteOffCount(db: DbOrTx): number {
  return db
    .select({ id: writeOffs.id })
    .from(writeOffs)
    .innerJoin(billsOfLading, eq(billsOfLading.id, writeOffs.blId))
    .where(and(eq(writeOffs.state, "PROPOSED"), isNull(billsOfLading.voidedAt)))
    .all().length;
}

/** Operations proposes writing off the rest of an open B/L with a reason; nothing changes until an admin approves. */
export function proposeWriteOff(db: Db, actor: AuthUser, input: { blId: number; reason: string }, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "writeOff.propose");
  return db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    if (!OPEN.includes(bl.status as StoredBlStatus)) throw new DomainError("writeOffs.errors.closed");
    if (pendingWriteOff(tx, bl.id)) throw new DomainError("writeOffs.errors.pending");
    const amountMinor = writeOffAmount(tx, bl);
    if (amountMinor <= 0) throw new DomainError("writeOffs.errors.nothingLeft");
    const row = tx
      .insert(writeOffs)
      .values({ blId: bl.id, amountMinor, currency: bl.currency, reason: input.reason, proposedBy: actor.id, proposedAt: now.toISOString() })
      .returning()
      .get();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "writeOff.propose", entityType: "bill_of_lading", entityId: bl.id, after: { writeOffId: row.id, amountMinor }, reason: input.reason },
      now,
    );
    notify(
      tx,
      {
        userIds: usersWithRole(tx, "ADMIN"),
        actorId: actor.id,
        kind: "WRITE_OFF_PROPOSED",
        entityType: "write_off",
        entityId: row.id,
        detail: { actor: actor.displayName, blNo: bl.blNo, amountMinor, currency: bl.currency, reason: input.reason },
      },
      now,
    );
    return row.id;
  });
}

function proposal(tx: DbOrTx, writeOffId: number) {
  const row = tx.select().from(writeOffs).where(eq(writeOffs.id, writeOffId)).get();
  if (!row) throw new DomainError("errors.notFound");
  if (row.state !== "PROPOSED") throw new DomainError("writeOffs.errors.decided");
  return row;
}

/**
 * Admin approval (rule 16): the unexplained deductions are replaced by one WRITE_OFF
 * deduction for the proposed amount, which closes the balance, and the B/L is collected.
 * If the B/L changed since the proposal (an allocation, a deduction), approval is refused.
 */
export function approveWriteOff(db: Db, actor: AuthUser, input: { writeOffId: number; note: string | null }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "writeOff.decide");
  db.transaction((tx) => {
    const writeOff = proposal(tx, input.writeOffId);
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, writeOff.blId)).get()!;
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    if (writeOffAmount(tx, bl) !== writeOff.amountMinor) throw new DomainError("writeOffs.errors.amountChanged");
    let status: StoredBlStatus;
    try {
      status = nextStatus(bl.status as StoredBlStatus, "WRITE_OFF_APPROVED");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("writeOffs.errors.closed");
      throw error;
    }
    for (const entry of openUnexplained(tx, bl.id)) compensateLedgerEntry(tx, entry, actor.id, now);
    const type = tx.select().from(deductionTypes).where(eq(deductionTypes.code, "WRITE_OFF")).get()!;
    const entry = addLedgerEntry(
      tx,
      {
        blId: bl.id,
        type: "DEDUCTION",
        amountMinor: writeOff.amountMinor,
        currency: writeOff.currency,
        entryDate: istanbulToday(now),
        deduction: { typeId: type.id, source: "WRITE_OFF" },
        createdBy: actor.id,
      },
      now,
    );
    if (blLedgerBalance(tx, bl).expectedMinor !== 0) throw new DomainError("writeOffs.errors.amountChanged");
    const at = now.toISOString();
    tx.update(writeOffs)
      .set({ state: "APPROVED", decidedBy: actor.id, decidedAt: at, decisionNote: input.note, ledgerEntryId: entry.id })
      .where(eq(writeOffs.id, writeOff.id))
      .run();
    tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "writeOff.approve",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status },
        after: { status, writeOffId: writeOff.id, amountMinor: writeOff.amountMinor },
        reason: input.note,
      },
      now,
    );
    notifyDecision(tx, actor, writeOff, bl.blNo, "APPROVED", input.note, now);
  });
}

/** The proposer learns the outcome. */
function notifyDecision(
  tx: DbOrTx,
  actor: AuthUser,
  writeOff: typeof writeOffs.$inferSelect,
  blNo: string,
  decision: "APPROVED" | "REJECTED",
  note: string | null,
  now: Date,
) {
  notify(
    tx,
    {
      userIds: [writeOff.proposedBy],
      actorId: actor.id,
      kind: "WRITE_OFF_DECIDED",
      entityType: "bill_of_lading",
      entityId: writeOff.blId,
      detail: { actor: actor.displayName, blNo, decision, amountMinor: writeOff.amountMinor, currency: writeOff.currency, note },
    },
    now,
  );
}

/** Admin rejection with a reason; the B/L stays as it is. */
export function rejectWriteOff(db: Db, actor: AuthUser, input: { writeOffId: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "writeOff.decide");
  db.transaction((tx) => {
    const writeOff = proposal(tx, input.writeOffId);
    tx.update(writeOffs)
      .set({ state: "REJECTED", decidedBy: actor.id, decidedAt: now.toISOString(), decisionNote: input.reason })
      .where(eq(writeOffs.id, writeOff.id))
      .run();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "writeOff.reject", entityType: "bill_of_lading", entityId: writeOff.blId, after: { writeOffId: writeOff.id }, reason: input.reason },
      now,
    );
    const bl = tx.select({ blNo: billsOfLading.blNo }).from(billsOfLading).where(eq(billsOfLading.id, writeOff.blId)).get()!;
    notifyDecision(tx, actor, writeOff, bl.blNo, "REJECTED", input.reason, now);
  });
}

export type WriteOffRow = {
  id: number;
  blId: number;
  blNo: string;
  agencyName: string;
  amountMinor: number;
  currency: string;
  reason: string;
  state: WriteOffState;
  proposedByName: string;
  proposedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Pending only: what a write-off would cover now; differs when the B/L changed since. */
  currentAmountMinor: number | null;
};

const DECIDED_SHOWN = 50;
const decider = alias(users, "decider");

function writeOffQuery(db: DbOrTx) {
  return db
    .select({ writeOff: writeOffs, bl: billsOfLading, agencyName: agencies.name, proposedByName: users.displayName, decidedByName: decider.displayName })
    .from(writeOffs)
    .innerJoin(billsOfLading, eq(billsOfLading.id, writeOffs.blId))
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .innerJoin(users, eq(users.id, writeOffs.proposedBy))
    .leftJoin(decider, eq(decider.id, writeOffs.decidedBy));
}

function toRow(db: DbOrTx, { writeOff, bl, agencyName, proposedByName, decidedByName }: ReturnType<ReturnType<typeof writeOffQuery>["all"]>[number]): WriteOffRow {
  return {
    id: writeOff.id,
    blId: bl.id,
    blNo: bl.blNo,
    agencyName,
    amountMinor: writeOff.amountMinor,
    currency: writeOff.currency,
    reason: writeOff.reason,
    state: writeOff.state,
    proposedByName,
    proposedAt: writeOff.proposedAt,
    decidedByName,
    decidedAt: writeOff.decidedAt,
    decisionNote: writeOff.decisionNote,
    currentAmountMinor: writeOff.state === "PROPOSED" && !bl.voidedAt ? writeOffAmount(db, bl) : null,
  };
}

/** Write-off approvals (admin): proposals waiting oldest first, and the latest decisions. */
export function listWriteOffs(db: DbOrTx, actor: AuthUser): { pending: WriteOffRow[]; decided: WriteOffRow[] } {
  authorize(actor, "writeOff.view");
  return {
    pending: writeOffQuery(db)
      .where(and(eq(writeOffs.state, "PROPOSED"), isNull(billsOfLading.voidedAt)))
      .orderBy(writeOffs.proposedAt, writeOffs.id)
      .all()
      .map((row) => toRow(db, row)),
    decided: writeOffQuery(db)
      .where(inArray(writeOffs.state, ["APPROVED", "REJECTED"]))
      .orderBy(desc(writeOffs.decidedAt), desc(writeOffs.id))
      .limit(DECIDED_SHOWN)
      .all()
      .map((row) => toRow(db, row)),
  };
}

/** Write-offs of one B/L for its detail, newest first. */
export function blWriteOffs(db: DbOrTx, blId: number): WriteOffRow[] {
  return writeOffQuery(db)
    .where(eq(writeOffs.blId, blId))
    .orderBy(desc(writeOffs.id))
    .all()
    .map((row) => toRow(db, row));
}
