import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday } from "@/domain/business-days";
import type { ClassifyDeductionInput, DeductionLineInput, RecordStatementDeductionsInput } from "@/lib/schemas/deductions";
import { formatMoney } from "@/lib/money";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { billsOfLading, deductionTypes, documents, emailAttachments, emailBlLinks, ledgerEntries } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument } from "./files";
import { activeLedgerEntries, addLedgerEntry, compensateLedgerEntry, type LedgerEntry } from "./ledger";

type BlRow = typeof billsOfLading.$inferSelect;
type DeductionTypeRow = typeof deductionTypes.$inferSelect;

/** Statuses that take deductions from a statement: requested, nothing paid yet. */
const BEFORE_PAYMENT: readonly StoredBlStatus[] = ["REQUESTED", "AWAITING_RETURN"];

function activeBl(tx: DbOrTx, blId: number): BlRow {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("bls.errors.voided");
  return bl;
}

export function blLedgerBalance(tx: DbOrTx, bl: BlRow) {
  return blBalance(tx.select().from(ledgerEntries).where(eq(ledgerEntries.blId, bl.id)).all(), bl.currency);
}

/** The unexplained deductions in effect on a B/L (rule 4: none may be left when it closes). */
export function openUnexplained(tx: DbOrTx, blId: number): LedgerEntry[] {
  const unexplained = tx.select({ id: deductionTypes.id }).from(deductionTypes).where(eq(deductionTypes.code, "UNEXPLAINED")).get();
  return activeLedgerEntries(tx, blId, ["DEDUCTION"]).filter((e) => e.deductionTypeId === unexplained?.id);
}

/** What a user can enter on a B/L now: deductions from a statement, or the real type of an unexplained one. */
export type DeductionTarget =
  | { mode: "STATEMENT"; expectedMinor: number }
  | { mode: "CLASSIFY"; entryId: number; amountMinor: number; disputed: boolean };

export function deductionTarget(tx: DbOrTx, bl: BlRow): DeductionTarget | null {
  if (bl.voidedAt) return null;
  if (BEFORE_PAYMENT.includes(bl.status as StoredBlStatus)) return { mode: "STATEMENT", expectedMinor: blLedgerBalance(tx, bl).expectedMinor };
  const entry = bl.status === "DEDUCTION_OPEN" || bl.status === "DISPUTED" ? openUnexplained(tx, bl.id)[0] : undefined;
  return entry ? { mode: "CLASSIFY", entryId: entry.id, amountMinor: entry.amountMinor, disputed: entry.disputed } : null;
}

/** Lines typed by a user carry a real type: active, and not one of the system types. */
function realTypes(tx: DbOrTx, lines: DeductionLineInput[]): DeductionTypeRow[] {
  const ids = [...new Set(lines.map((l) => l.deductionTypeId))];
  const rows = tx.select().from(deductionTypes).where(inArray(deductionTypes.id, ids)).all();
  return lines.map((line) => {
    const type = rows.find((r) => r.id === line.deductionTypeId);
    if (!type || !type.active || type.code !== null) throw new DomainError("deductions.errors.type");
    return type;
  });
}

/**
 * The statement behind a deduction: a fresh upload by the actor (attached to the B/L now),
 * a statement already on this B/L, or an attachment of an agency email linked to it.
 */
function statementDocument(tx: DbOrTx, actor: AuthUser, bl: BlRow, documentId: number): number {
  const doc = tx.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!doc) throw new DomainError("deductions.errors.statementDocument");
  if (doc.ownerType === null) {
    attachDocument(tx, actor, { documentId, kind: "DEDUCTION_STATEMENT", ownerType: "bill_of_lading", ownerId: bl.id });
    return documentId;
  }
  if (doc.ownerType === "bill_of_lading" && doc.ownerId === bl.id && doc.kind === "DEDUCTION_STATEMENT") return documentId;
  const fromLinkedEmail = tx
    .select({ documentId: emailAttachments.documentId })
    .from(emailAttachments)
    .innerJoin(emailBlLinks, eq(emailBlLinks.emailId, emailAttachments.emailId))
    .where(and(eq(emailAttachments.documentId, documentId), eq(emailBlLinks.blId, bl.id), isNull(emailBlLinks.unlinkedAt)))
    .get();
  if (!fromLinkedEmail) throw new DomainError("deductions.errors.statementDocument");
  return documentId;
}

/**
 * Deductions from an agency statement before payment: entered per B/L with their type and
 * the statement. They lower what the agency still owes, so the later refund matches exactly;
 * the status does not change. When they take the whole deposit (e.g. the agency applied it to
 * one of its invoices), the balance is closed and the B/L is collected without a refund.
 */
export function recordStatementDeductions(db: Db, actor: AuthUser, input: RecordStatementDeductionsInput, now: Date = new Date()): number[] {
  const roleUsed = authorize(actor, "deduction.record");
  return db.transaction((tx) => {
    const bl = activeBl(tx, input.blId);
    if (!BEFORE_PAYMENT.includes(bl.status as StoredBlStatus)) throw new DomainError("deductions.errors.statementStatus", { bl: bl.blNo });
    const types = realTypes(tx, input.lines);
    const before = blLedgerBalance(tx, bl);
    const total = input.lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (total > before.expectedMinor) {
      throw new DomainError("deductions.errors.exceedsExpected", { bl: bl.blNo, amount: formatMoney(before.expectedMinor, bl.currency) });
    }
    const documentId = statementDocument(tx, actor, bl, input.documentId);
    const entryDate = istanbulToday(now);
    const entries = input.lines.map((line, i) =>
      addLedgerEntry(
        tx,
        {
          blId: bl.id,
          type: "DEDUCTION",
          amountMinor: line.amountMinor,
          currency: bl.currency,
          entryDate,
          deduction: { typeId: types[i].id, source: "STATEMENT" },
          documentId,
          createdBy: actor.id,
        },
        now,
      ),
    );
    let status = bl.status as StoredBlStatus;
    if (total === before.expectedMinor) {
      status = nextStatus(status, "STATEMENT_SETTLED");
      tx.update(billsOfLading).set({ status, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
    }
    const auditId = writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "deduction.statement",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status, expectedMinor: before.expectedMinor },
        after: {
          status,
          expectedMinor: before.expectedMinor - total,
          documentId,
          // The entries an undo compensates.
          entryIds: entries.map((e) => e.id),
          lines: input.lines.map((l, i) => ({ deductionType: types[i].name, amountMinor: l.amountMinor })),
        },
      },
      now,
    );
    return [auditId];
  });
}

/** An unexplained deduction in effect, with its B/L. */
function unexplainedEntry(tx: DbOrTx, entryId: number): { entry: LedgerEntry; bl: BlRow } {
  const row = tx.select().from(ledgerEntries).where(eq(ledgerEntries.id, entryId)).get();
  if (!row || row.type !== "DEDUCTION") throw new DomainError("errors.notFound");
  const bl = activeBl(tx, row.blId);
  const entry = openUnexplained(tx, bl.id).find((e) => e.id === entryId);
  if (!entry) throw new DomainError("deductions.errors.notUnexplained");
  return { entry, bl };
}

/**
 * Replaces an unexplained deduction by its real type(s), e.g. once the agency's statement
 * arrived, or when a dispute is cleared by accepting the deduction (a note is then required).
 * The new entries keep the allocation they came with, so a reversal still finds them. With
 * no unexplained deduction left and the balance closed, the B/L is collected (rules 1, 4).
 */
export function classifyDeduction(db: Db, actor: AuthUser, input: ClassifyDeductionInput, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "deduction.record");
  db.transaction((tx) => {
    const { entry, bl } = unexplainedEntry(tx, input.entryId);
    if (bl.status === "DISPUTED" && !input.note) throw new DomainError("deductions.errors.clearNote");
    const types = realTypes(tx, input.lines);
    const total = input.lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (total !== entry.amountMinor) throw new DomainError("deductions.errors.mustEqual", { amount: formatMoney(entry.amountMinor, entry.currency) });
    const documentId = input.documentId === null ? null : statementDocument(tx, actor, bl, input.documentId);

    compensateLedgerEntry(tx, entry, actor.id, now);
    const entryDate = istanbulToday(now);
    input.lines.forEach((line, i) =>
      addLedgerEntry(
        tx,
        {
          blId: bl.id,
          type: "DEDUCTION",
          amountMinor: line.amountMinor,
          currency: entry.currency,
          entryDate,
          refundAllocationId: entry.refundAllocationId,
          deduction: { typeId: types[i].id, source: entry.deductionSource! },
          documentId,
          createdBy: actor.id,
        },
        now,
      ),
    );

    let status = bl.status as StoredBlStatus;
    if (openUnexplained(tx, bl.id).length === 0 && blLedgerBalance(tx, bl).expectedMinor === 0) {
      try {
        status = nextStatus(status, "DEDUCTION_CLASSIFIED");
      } catch (error) {
        if (error instanceof InvalidTransitionError) throw new DomainError("deductions.errors.notUnexplained");
        throw error;
      }
      tx.update(billsOfLading).set({ status, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: bl.status === "DISPUTED" ? "deduction.disputeCleared" : "deduction.classify",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status, entryId: entry.id, amountMinor: entry.amountMinor, disputed: entry.disputed },
        after: { status, documentId, lines: input.lines.map((l, i) => ({ deductionType: types[i].name, amountMinor: l.amountMinor })) },
        reason: input.note,
      },
      now,
    );
  });
}

/**
 * Operations disputes an unexplained deduction with a note: the B/L moves to DISPUTED and
 * stays open until the agency pays the difference or the dispute is cleared.
 */
export function disputeDeduction(db: Db, actor: AuthUser, input: { entryId: number; note: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "deduction.dispute");
  db.transaction((tx) => {
    const { entry, bl } = unexplainedEntry(tx, input.entryId);
    if (entry.disputed) throw new DomainError("deductions.errors.alreadyDisputed");
    let status: StoredBlStatus;
    try {
      status = nextStatus(bl.status as StoredBlStatus, "DEDUCTION_DISPUTED");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("deductions.errors.notUnexplained");
      throw error;
    }
    tx.update(ledgerEntries).set({ disputed: true, disputeNote: input.note }).where(eq(ledgerEntries.id, entry.id)).run();
    tx.update(billsOfLading).set({ status, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "deduction.dispute",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status },
        after: { status, entryId: entry.id, amountMinor: entry.amountMinor },
        reason: input.note,
      },
      now,
    );
  });
}
