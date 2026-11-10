import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { tableLayoutSchema, type TableLayout } from "@/lib/schemas/table-layout";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { DbOrTx } from "./db/client";
import { customers, userPreferences } from "./db/schema";
import { DomainError } from "./errors";

const tableKey = (tableId: string) => `table:${tableId}`;

/** Saved layout, or null when none is stored or it no longer matches the schema. */
export function getTableLayout(db: DbOrTx, userId: number, tableId: string): TableLayout | null {
  const row = db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, tableKey(tableId))))
    .get();
  if (!row) return null;
  const parsed = tableLayoutSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

/** Personal UI state only; not a business change, so it is not audited. */
export function saveTableLayout(
  db: DbOrTx,
  user: AuthUser,
  tableId: string,
  layout: TableLayout,
  now: Date = new Date(),
): void {
  authorize(user, "preferences.saveOwn");
  const key = tableKey(tableId);
  const updatedAt = now.toISOString();
  db.insert(userPreferences)
    .values({ userId: user.id, key, value: layout, updatedAt })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: layout, updatedAt } })
    .run();
}

const CUSTOMER_FILTER = "customerFilter";
const customerFilterSchema = z.object({ customerIds: z.array(z.number().int().positive()) });

/** The customers a user follows; empty means all (no filter). */
export function getCustomerFilter(db: DbOrTx, userId: number): number[] {
  const row = db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, CUSTOMER_FILTER)))
    .get();
  const parsed = customerFilterSchema.safeParse(row?.value);
  return parsed.success ? parsed.data.customerIds : [];
}

/** Personal setting, like table layouts: not a business change, so not audited. */
export function saveCustomerFilter(db: DbOrTx, user: AuthUser, customerIds: number[], now: Date = new Date()): void {
  authorize(user, "preferences.saveOwn");
  const ids = [...new Set(customerIds)];
  const known = new Set(db.select({ id: customers.id }).from(customers).all().map((c) => c.id));
  if (ids.some((id) => !known.has(id))) throw new DomainError("customers.errors.unknown");
  const value = { customerIds: ids };
  const updatedAt = now.toISOString();
  db.insert(userPreferences)
    .values({ userId: user.id, key: CUSTOMER_FILTER, value, updatedAt })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value, updatedAt } })
    .run();
}

/**
 * Whether a record is in the viewer's customer filter (Customer filter): with no filter
 * everything is, and records without a customer always are. A convenience, not access control.
 */
export function customerScope(db: DbOrTx, viewer: AuthUser): (customerId: number | null) => boolean {
  const followed = new Set(getCustomerFilter(db, viewer.id));
  return (customerId) => followed.size === 0 || customerId === null || followed.has(customerId);
}

const GETTING_STARTED = "gettingStarted";

/**
 * Whether the user still has to see the getting-started guide, which the dashboard opens
 * once; marking it seen is a personal setting, not audited.
 */
export function takeGettingStarted(db: DbOrTx, user: AuthUser, now: Date = new Date()): boolean {
  authorize(user, "preferences.saveOwn");
  const seen = db
    .select({ key: userPreferences.key })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, GETTING_STARTED)))
    .get();
  if (seen) return false;
  db.insert(userPreferences).values({ userId: user.id, key: GETTING_STARTED, value: { seenAt: now.toISOString() }, updatedAt: now.toISOString() }).onConflictDoNothing().run();
  return true;
}
