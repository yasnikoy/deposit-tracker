import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { AuthUser } from "./auth/types";
import type { DbOrTx } from "./db/client";
import { billsOfLading, users } from "./db/schema";
import { DomainError } from "./errors";
import { getSetting } from "./settings";

const lockExpired = (lockedAt: string | null, timeoutMinutes: number, now: Date) =>
  !lockedAt || new Date(lockedAt).getTime() + timeoutMinutes * 60_000 <= now.getTime();

/**
 * Rule 14: a B/L being drafted by one user is locked for others. Throws when another user
 * holds a live lock on one of the B/Ls; otherwise (re)takes the lock for the actor.
 */
export function lockForDraft(tx: DbOrTx, actor: AuthUser, blIds: number[], now: Date): void {
  const timeout = getSetting("rules.draftLockTimeoutMinutes", {}, tx);
  const rows = tx
    .select({ id: billsOfLading.id, blNo: billsOfLading.blNo, lockedBy: billsOfLading.lockedBy, lockedAt: billsOfLading.lockedAt, lockerName: users.displayName })
    .from(billsOfLading)
    .leftJoin(users, eq(users.id, billsOfLading.lockedBy))
    .where(inArray(billsOfLading.id, blIds))
    .all();
  for (const row of rows) {
    if (row.lockedBy !== null && row.lockedBy !== actor.id && !lockExpired(row.lockedAt, timeout, now)) {
      throw new DomainError("requests.errors.locked", { bl: row.blNo, user: row.lockerName ?? "" });
    }
  }
  tx.update(billsOfLading).set({ lockedBy: actor.id, lockedAt: now.toISOString() }).where(inArray(billsOfLading.id, blIds)).run();
}

/** Releases the actor's own draft locks (sent or cancelled). */
export function releaseDraftLocks(tx: DbOrTx, actor: AuthUser, blIds: number[]): void {
  tx.update(billsOfLading)
    .set({ lockedBy: null, lockedAt: null })
    .where(and(inArray(billsOfLading.id, blIds), eq(billsOfLading.lockedBy, actor.id)))
    .run();
}

/** Who else is drafting a B/L right now, for the lock badge; null when free or the viewer's own. */
export function activeLockers(tx: DbOrTx, viewer: AuthUser, now: Date): Map<number, string> {
  const timeout = getSetting("rules.draftLockTimeoutMinutes", {}, tx);
  const rows = tx
    .select({ id: billsOfLading.id, lockedBy: billsOfLading.lockedBy, lockedAt: billsOfLading.lockedAt, name: users.displayName })
    .from(billsOfLading)
    .innerJoin(users, eq(users.id, billsOfLading.lockedBy))
    .all();
  return new Map(
    rows.filter((r) => r.lockedBy !== viewer.id && !lockExpired(r.lockedAt, timeout, now)).map((r) => [r.id, r.name] as const),
  );
}
