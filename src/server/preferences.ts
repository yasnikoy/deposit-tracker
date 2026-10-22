import "server-only";
import { and, eq } from "drizzle-orm";
import { tableLayoutSchema, type TableLayout } from "@/lib/schemas/table-layout";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { DbOrTx } from "./db/client";
import { userPreferences } from "./db/schema";

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
