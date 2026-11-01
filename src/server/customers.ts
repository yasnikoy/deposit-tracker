import "server-only";
import { and, asc, eq, ne } from "drizzle-orm";
import { matchByAliases } from "@/domain/agency";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { Role } from "@/domain/roles";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { customers } from "./db/schema";
import { DomainError } from "./errors";

export type Customer = typeof customers.$inferSelect;
export type CustomerInput = { name: string; code: string | null; aliases: string[] };

/** Registers an importer we pay deposits for; the name and code are unique. */
export function createCustomer(db: Db, actor: AuthUser, input: CustomerInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "customer.manage");
  return db.transaction((tx) => insertCustomer(tx, actor, roleUsed, input, now));
}

// Compared in Turkish case: SQLite's lower() folds ASCII letters only.
const fold = (value: string) => value.toLocaleLowerCase("tr-TR");

function insertCustomer(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, input: CustomerInput, now: Date): number {
  const name = input.name.trim();
  if (name === "") throw new DomainError("common.required");
  if (tx.select({ name: customers.name }).from(customers).all().some((c) => fold(c.name) === fold(name))) {
    throw new DomainError("customers.errors.nameTaken");
  }
  if (input.code && tx.select({ id: customers.id }).from(customers).where(eq(customers.code, input.code)).get()) {
    throw new DomainError("customers.errors.codeTaken");
  }
  const at = now.toISOString();
  const row = tx
    .insert(customers)
    .values({ name, code: input.code || null, aliases: input.aliases.map((a) => a.trim()).filter(Boolean), createdAt: at, updatedAt: at })
    .returning()
    .get();
  writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "customer.create", entityType: "customer", entityId: row.id, after: { name: row.name, code: row.code, aliases: row.aliases } }, now);
  return row.id;
}

/**
 * The customer a record names by text, inside that record's transaction (the caller has
 * authorized the record): an active customer of that name is used as it is, otherwise one is
 * registered with only its name.
 */
export function customerForNewName(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, rawName: string, now: Date): number {
  const name = rawName.trim();
  const existing = tx.select().from(customers).all().find((c) => fold(c.name) === fold(name));
  if (existing) {
    if (!existing.active) throw new DomainError("customers.errors.unknown");
    return existing.id;
  }
  return insertCustomer(tx, actor, roleUsed, { name, code: null, aliases: [] }, now);
}

/** Saves a customer card (accounting or operations); deactivated customers stay on their records. */
export function updateCustomer(
  db: Db,
  actor: AuthUser,
  input: { id: number; customer: { name: string; code: string | null; aliases: string[]; active: boolean } },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "customer.manage");
  db.transaction((tx) => {
    const before = tx.select().from(customers).where(eq(customers.id, input.id)).get();
    if (!before) throw new DomainError("errors.notFound");
    const name = input.customer.name.trim();
    if (name === "") throw new DomainError("common.required");
    if (tx.select().from(customers).all().some((c) => c.id !== input.id && fold(c.name) === fold(name))) {
      throw new DomainError("customers.errors.nameTaken");
    }
    const code = input.customer.code || null;
    if (code && tx.select().from(customers).all().some((c) => c.id !== input.id && c.code === code)) {
      throw new DomainError("customers.errors.codeTaken");
    }
    const aliases = [...new Set(input.customer.aliases.map((a) => a.trim()).filter(Boolean))];
    const card = (c: { name: string; code: string | null; aliases: string[]; active: boolean }) => ({ name: c.name, code: c.code, aliases: c.aliases, active: c.active });
    const after = { name, code, aliases, active: input.customer.active };
    if (JSON.stringify(card(before)) === JSON.stringify(after)) throw new DomainError("settings.noChanges");
    tx.update(customers).set({ ...after, updatedAt: now.toISOString() }).where(eq(customers.id, input.id)).run();
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "customer.update", entityType: "customer", entityId: input.id, before: card(before), after }, now);
  });
}

export function listCustomers(db: DbOrTx, actor: AuthUser): Customer[] {
  authorize(actor, "customer.view");
  return db.select().from(customers).orderBy(asc(customers.name)).all();
}

/**
 * The customer a transfer description names, by its aliases (or its name); only when exactly
 * one active customer matches, since it is filled in without asking.
 */
export function suggestCustomer(tx: DbOrTx, text: string): number | null {
  const active = tx.select().from(customers).where(and(eq(customers.active, true), ne(customers.name, ""))).all();
  const ids = matchByAliases(text, active.map((c) => ({ id: c.id, aliases: [...c.aliases, c.name] })));
  return ids.length === 1 ? ids[0] : null;
}
