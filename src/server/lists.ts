import "server-only";
import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { normalizeIban } from "@/domain/iban";
import { DEDUCTION_TYPE_CODES, type DeductionTypeCode } from "@/domain/records";
import { REPLY_TYPE_CODES, type ReplyTypeCode } from "@/domain/replies";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { bankAccounts, currencies, deductionTypes, replyTypes } from "./db/schema";
import { DomainError } from "./errors";
import { SEED_FILE } from "./settings";

export type Currency = typeof currencies.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type ReplyType = typeof replyTypes.$inferSelect;
export type DeductionType = typeof deductionTypes.$inferSelect;

/** Loads the seed currencies on first start (when the list is still empty). */
export function seedLists(db: Db, seedFile: string = SEED_FILE): string[] {
  if (db.select({ code: currencies.code }).from(currencies).limit(1).get()) return [];
  const seed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ seedFile, "utf8")) as {
    lists?: { currencies?: { code: string; name: string }[] };
  };
  const rows = seed.lists?.currencies ?? [];
  db.transaction((tx) => {
    rows.forEach((row, index) => {
      tx.insert(currencies).values({ code: row.code, name: row.name, sortOrder: index }).run();
      writeAudit(tx, { actorUserId: null, roleUsed: null, action: "currency.seed", entityType: "currency", entityId: row.code, after: row });
    });
  });
  return rows.map((r) => r.code);
}

export function listCurrencies(db: DbOrTx, actor: AuthUser): Currency[] {
  authorize(actor, "lists.view");
  return db.select().from(currencies).orderBy(asc(currencies.sortOrder), asc(currencies.code)).all();
}

export function listBankAccounts(db: DbOrTx, actor: AuthUser): BankAccount[] {
  authorize(actor, "lists.view");
  return db.select().from(bankAccounts).orderBy(asc(bankAccounts.sortOrder), asc(bankAccounts.name)).all();
}

export function saveCurrency(
  db: Db,
  actor: AuthUser,
  input: { code: string; name: string; active: boolean; reason: string | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "lists.manage");
  db.transaction((tx) => {
    const before = tx.select().from(currencies).where(eq(currencies.code, input.code)).get();
    if (before) {
      tx.update(currencies).set({ name: input.name, active: input.active }).where(eq(currencies.code, input.code)).run();
    } else {
      const count = tx.select({ code: currencies.code }).from(currencies).all().length;
      tx.insert(currencies).values({ code: input.code, name: input.name, active: input.active, sortOrder: count }).run();
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: before ? "currency.update" : "currency.create",
        entityType: "currency",
        entityId: input.code,
        before: before ? { name: before.name, active: before.active } : null,
        after: { name: input.name, active: input.active },
        reason: input.reason,
      },
      now,
    );
  });
}

export function saveBankAccount(
  db: Db,
  actor: AuthUser,
  input: { id?: number; name: string; bankName: string; iban: string; currency: string; active: boolean; reason: string | null },
  now: Date = new Date(),
): number {
  const roleUsed = authorize(actor, "lists.manage");
  const at = now.toISOString();
  const iban = normalizeIban(input.iban);
  return db.transaction((tx) => {
    const currency = tx.select().from(currencies).where(eq(currencies.code, input.currency)).get();
    if (!currency) throw new DomainError("errors.validation");
    const duplicate = tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.iban, iban)).get();
    if (duplicate && duplicate.id !== input.id) throw new DomainError("lists.errors.ibanTaken");
    const values = { name: input.name, bankName: input.bankName, iban, currency: input.currency, active: input.active };

    if (input.id === undefined) {
      const row = tx.insert(bankAccounts).values({ ...values, createdAt: at, updatedAt: at }).returning().get();
      writeAudit(
        tx,
        { actorUserId: actor.id, roleUsed, action: "bankAccount.create", entityType: "bankAccount", entityId: row.id, after: values, reason: input.reason },
        now,
      );
      return row.id;
    }
    const before = tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.id)).get();
    if (!before) throw new DomainError("errors.notFound");
    tx.update(bankAccounts).set({ ...values, updatedAt: at }).where(eq(bankAccounts.id, input.id)).run();
    const { name, bankName, iban: oldIban, currency: oldCurrency, active } = before;
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bankAccount.update",
        entityType: "bankAccount",
        entityId: input.id,
        before: { name, bankName, iban: oldIban, currency: oldCurrency, active },
        after: values,
        reason: input.reason,
      },
      now,
    );
    return input.id;
  });
}

// ---- Coded type lists: reply types and deduction types ----

type CodedList<Code extends string> = {
  table: typeof replyTypes | typeof deductionTypes;
  codes: readonly Code[];
  seedKey: "replyTypes" | "deductionTypes";
  entity: "replyType" | "deductionType";
};

const REPLY_TYPES: CodedList<ReplyTypeCode> = { table: replyTypes, codes: REPLY_TYPE_CODES, seedKey: "replyTypes", entity: "replyType" };
const DEDUCTION_TYPES: CodedList<DeductionTypeCode> = {
  table: deductionTypes,
  // Seed types without a code (e.g. demurrage) are loaded on first start only.
  codes: [...DEDUCTION_TYPE_CODES],
  seedKey: "deductionTypes",
  entity: "deductionType",
};

/**
 * Loads seed types missing from the database. System types (with a code) are added once
 * each, so a later release can bring a new one; types without a code are seeded only into an
 * empty list, and those an admin adds never come from here.
 */
function seedCodedList<Code extends string>(db: Db, list: CodedList<Code>, seedFile: string, now: Date): string[] {
  const seed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ seedFile, "utf8")) as {
    lists?: Partial<Record<CodedList<Code>["seedKey"], { code?: Code; name: string }[]>>;
  };
  const rows = seed.lists?.[list.seedKey] ?? [];
  const inserted: string[] = [];
  db.transaction((tx) => {
    const existing = tx.select().from(list.table).all();
    for (const code of list.codes) {
      if (!rows.some((r) => r.code === code)) throw new Error(`${list.entity} "${code}" is missing from the seed file`);
    }
    rows.forEach((row, index) => {
      if (row.code ? existing.some((e) => e.code === row.code) : existing.length > 0) return;
      const at = now.toISOString();
      const created = tx
        .insert(list.table)
        .values({ code: (row.code ?? null) as never, name: row.name, sortOrder: index, createdAt: at, updatedAt: at })
        .returning()
        .get();
      writeAudit(tx, { actorUserId: null, roleUsed: null, action: `${list.entity}.seed`, entityType: list.entity, entityId: created.id, after: row }, now);
      inserted.push(row.code ?? row.name);
    });
  });
  return inserted;
}

/** Admin: add a type, or rename, reorder or (types without a code only) deactivate one. */
function saveCodedType(
  db: Db,
  actor: AuthUser,
  list: CodedList<string>,
  input: { id?: number; name: string; active: boolean; sortOrder: number; reason: string | null },
  now: Date,
): number {
  const roleUsed = authorize(actor, "lists.manage");
  const at = now.toISOString();
  const table = list.table;
  return db.transaction((tx) => {
    const taken = tx
      .select()
      .from(table)
      .all()
      .find((r) => r.name.toLocaleLowerCase("tr") === input.name.toLocaleLowerCase("tr") && r.id !== input.id);
    if (taken) throw new DomainError("lists.errors.typeTaken");
    const values = { name: input.name, active: input.active, sortOrder: input.sortOrder };

    if (input.id === undefined) {
      const row = tx.insert(table).values({ ...values, code: null, createdAt: at, updatedAt: at }).returning().get();
      writeAudit(tx, { actorUserId: actor.id, roleUsed, action: `${list.entity}.create`, entityType: list.entity, entityId: row.id, after: values, reason: input.reason }, now);
      return row.id;
    }
    const before = tx.select().from(table).where(eq(table.id, input.id)).get();
    if (!before) throw new DomainError("errors.notFound");
    if (before.code && !input.active) throw new DomainError("lists.errors.systemType");
    tx.update(table).set({ ...values, updatedAt: at }).where(eq(table.id, input.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: `${list.entity}.update`,
        entityType: list.entity,
        entityId: input.id,
        before: { name: before.name, active: before.active, sortOrder: before.sortOrder },
        after: values,
        reason: input.reason,
      },
      now,
    );
    return input.id;
  });
}

type TypeInput = { id?: number; name: string; active: boolean; sortOrder: number; reason: string | null };

export function seedReplyTypes(db: Db, seedFile: string = SEED_FILE, now: Date = new Date()): string[] {
  return seedCodedList(db, REPLY_TYPES, seedFile, now);
}

export function listReplyTypes(db: DbOrTx, actor: AuthUser): ReplyType[] {
  authorize(actor, "lists.view");
  return db.select().from(replyTypes).orderBy(asc(replyTypes.sortOrder), asc(replyTypes.id)).all();
}

export function saveReplyType(db: Db, actor: AuthUser, input: TypeInput, now: Date = new Date()): number {
  return saveCodedType(db, actor, REPLY_TYPES, input, now);
}

export function seedDeductionTypes(db: Db, seedFile: string = SEED_FILE, now: Date = new Date()): string[] {
  return seedCodedList(db, DEDUCTION_TYPES, seedFile, now);
}

export function listDeductionTypes(db: DbOrTx, actor: AuthUser): DeductionType[] {
  authorize(actor, "lists.view");
  return db.select().from(deductionTypes).orderBy(asc(deductionTypes.sortOrder), asc(deductionTypes.id)).all();
}

export function saveDeductionType(db: Db, actor: AuthUser, input: TypeInput, now: Date = new Date()): number {
  return saveCodedType(db, actor, DEDUCTION_TYPES, input, now);
}
