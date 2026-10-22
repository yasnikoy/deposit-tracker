import "server-only";
import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { normalizeIban } from "@/domain/iban";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { bankAccounts, currencies } from "./db/schema";
import { DomainError } from "./errors";
import { SEED_FILE } from "./settings";

export type Currency = typeof currencies.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;

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
