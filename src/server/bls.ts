import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isTranslationKey, type TranslationKey } from "@/i18n";
import { blRowSchema, type BlRowInput } from "@/lib/schemas/bls";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx, Tx } from "./db/client";
import { billsOfLading, containers, depositPayments } from "./db/schema";
import { DomainError } from "./errors";
import { nameBlDocuments, type DocumentRename } from "./files";
import { addLedgerEntry, hasConfirmedAllocation } from "./ledger";

export type BlRowError = {
  index: number;
  field: "blNo" | "containers" | "payment";
  message: TranslationKey;
  /** 1-based position in the container list, for container errors. */
  item?: number;
};

export type CreateBlsResult = {
  created: { index: number; paymentId: number; blId: number; blNo: string }[];
  errors: BlRowError[];
};

export const blNoTaken = (tx: DbOrTx, blNo: string, exceptId?: number) =>
  tx
    .select({ id: billsOfLading.id })
    .from(billsOfLading)
    .where(and(eq(sql`upper(${billsOfLading.blNo})`, blNo), isNull(billsOfLading.voidedAt)))
    .all()
    .some((row) => row.id !== exceptId);

function insertBl(tx: Tx, actor: AuthUser, roleUsed: AuthUser["roles"][number] | null, row: BlRowInput, now: Date): number {
  const payment = tx.select().from(depositPayments).where(eq(depositPayments.id, row.paymentId)).get()!;
  const at = now.toISOString();
  const bl = tx
    .insert(billsOfLading)
    .values({
      blNo: row.blNo,
      depositPaymentId: payment.id,
      agencyId: payment.agencyId,
      currency: payment.currency,
      depositAmountMinor: payment.amountMinor,
      paidAt: payment.paidAt,
      status: "PAID",
      createdBy: actor.id,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  if (row.containers.length > 0) {
    tx.insert(containers).values(row.containers.map((containerNo) => ({ blId: bl.id, containerNo }))).run();
  }
  addLedgerEntry(
    tx,
    {
      blId: bl.id,
      type: payment.kind === "BANK" ? "PAYMENT" : "OFFSET",
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      entryDate: payment.paidAt,
      depositPaymentId: payment.id,
      createdBy: actor.id,
    },
    now,
  );
  writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: "bl.create",
      entityType: "bill_of_lading",
      entityId: bl.id,
      after: {
        blNo: bl.blNo,
        depositPaymentId: payment.id,
        containers: row.containers,
        status: bl.status,
        renamed: nameBlDocuments(tx, bl),
      },
    },
    now,
  );
  return bl.id;
}

/**
 * Creates B/Ls from payment records (operations). Each row is validated on its own;
 * valid rows are saved together in one transaction, invalid rows come back with errors.
 */
export function createBls(db: Db, actor: AuthUser, rows: unknown[], now: Date = new Date()): CreateBlsResult {
  const roleUsed = authorize(actor, "bl.create");
  const errors: BlRowError[] = [];
  const parsed: { index: number; row: BlRowInput }[] = [];

  rows.forEach((raw, index) => {
    const result = blRowSchema.safeParse(raw);
    if (result.success) return void parsed.push({ index, row: result.data });
    const seen = new Set<string>();
    for (const issue of result.error.issues) {
      const field = issue.path[0] === "containers" ? "containers" : issue.path[0] === "blNo" ? "blNo" : "payment";
      if (seen.has(field)) continue;
      seen.add(field);
      errors.push({
        index,
        field,
        message: isTranslationKey(issue.message) ? issue.message : "errors.validation",
        item: field === "containers" && typeof issue.path[1] === "number" ? issue.path[1] + 1 : undefined,
      });
    }
  });

  const created = db.transaction((tx) => {
    const done: CreateBlsResult["created"] = [];
    const batchNumbers = new Map<string, number>();
    for (const { index, row } of parsed) {
      if (batchNumbers.has(row.blNo)) {
        errors.push({ index, field: "blNo", message: "bls.errors.blNoDuplicateInBatch" });
        continue;
      }
      batchNumbers.set(row.blNo, index);
      const payment = tx.select().from(depositPayments).where(eq(depositPayments.id, row.paymentId)).get();
      const hasBl = tx
        .select({ id: billsOfLading.id })
        .from(billsOfLading)
        .where(and(eq(billsOfLading.depositPaymentId, row.paymentId), isNull(billsOfLading.voidedAt)))
        .get();
      if (!payment || payment.voidedAt || hasBl) {
        errors.push({ index, field: "payment", message: "bls.errors.paymentUnavailable" });
        continue;
      }
      if (blNoTaken(tx, row.blNo)) {
        errors.push({ index, field: "blNo", message: "bls.errors.blNoTaken" });
        continue;
      }
      done.push({ index, paymentId: row.paymentId, blId: insertBl(tx, actor, roleUsed, row, now), blNo: row.blNo });
    }
    return done;
  });

  return { created, errors: errors.sort((a, b) => a.index - b.index) };
}

function requireBl(tx: DbOrTx, id: number) {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get();
  if (!bl) throw new DomainError("errors.notFound");
  return bl;
}

const containerNumbers = (tx: DbOrTx, blId: number) =>
  tx
    .select({ containerNo: containers.containerNo })
    .from(containers)
    .where(eq(containers.blId, blId))
    .orderBy(containers.id)
    .all()
    .map((c) => c.containerNo);

/** Edits the B/L number (only before any request is sent) and the container list. */
export function updateBl(db: Db, actor: AuthUser, input: { id: number; blNo: string; containers: string[] }, now: Date = new Date()): number[] {
  const roleUsed = authorize(actor, "bl.update");
  return db.transaction((tx) => {
    const bl = requireBl(tx, input.id);
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    const beforeContainers = containerNumbers(tx, bl.id);
    let renamed: DocumentRename[] = [];
    if (input.blNo !== bl.blNo) {
      if (bl.status !== "PAID") throw new DomainError("bls.errors.blNoLocked");
      if (blNoTaken(tx, input.blNo, bl.id)) throw new DomainError("bls.errors.blNoTaken");
      tx.update(billsOfLading).set({ blNo: input.blNo, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
      renamed = nameBlDocuments(tx, { ...bl, blNo: input.blNo });
    }
    if (JSON.stringify(beforeContainers) !== JSON.stringify(input.containers)) {
      tx.delete(containers).where(eq(containers.blId, bl.id)).run();
      if (input.containers.length > 0) {
        tx.insert(containers).values(input.containers.map((containerNo) => ({ blId: bl.id, containerNo }))).run();
      }
    }
    const auditId = writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.update",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { blNo: bl.blNo, containers: beforeContainers },
        after: { blNo: input.blNo, containers: input.containers, ...(renamed.length ? { renamed } : {}) },
      },
      now,
    );
    return [auditId];
  });
}

/** Voids a B/L created with wrong data; its payment returns to "awaiting B/L" (rule 15). */
export function voidBl(db: Db, actor: AuthUser, input: { id: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.void");
  db.transaction((tx) => {
    const bl = requireBl(tx, input.id);
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    if (hasConfirmedAllocation(tx, bl.id)) throw new DomainError("bls.errors.allocated");
    tx.update(billsOfLading)
      .set({ voidedAt: now.toISOString(), voidedBy: actor.id, voidReason: input.reason, updatedAt: now.toISOString() })
      .where(eq(billsOfLading.id, bl.id))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.void",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { blNo: bl.blNo, status: bl.status, depositPaymentId: bl.depositPaymentId },
        reason: input.reason,
      },
      now,
    );
  });
}
