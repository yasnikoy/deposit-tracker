import "server-only";
import { and, asc, eq, ne } from "drizzle-orm";
import { matchByAliases } from "@/domain/agency";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { customers } from "./db/schema";
import { DomainError } from "./errors";

export type Customer = typeof customers.$inferSelect;
export type CustomerInput = { name: string; code: string | null; aliases: string[] };

/** Registers an importer we pay deposits for; the name and code are unique. */
export function createCustomer(db: Db, actor: AuthUser, input: CustomerInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "customer.manage");
  return db.transaction((tx) => {
    const name = input.name.trim();
    if (name === "") throw new DomainError("common.required");
    // Compared in Turkish case: SQLite's lower() folds ASCII letters only.
    const fold = (value: string) => value.toLocaleLowerCase("tr-TR");
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
