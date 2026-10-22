import "server-only";
import { eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { getSetting } from "../settings";
import { verifyAgainstDummy, verifyPassword } from "./password";

export type LoginResult = { ok: true; userId: number } | { ok: false; reason: "invalid" | "locked" };

/**
 * Checks credentials and applies the failed-login lockout setting.
 * Unknown, inactive and wrong-password logins all answer "invalid".
 * A locked account stays locked until an admin unlocks it or resets its password.
 */
export async function attemptLogin(
  db: Db,
  input: { username: string; password: string },
  now: Date = new Date(),
): Promise<LoginResult> {
  const user = db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, input.username.trim().toLowerCase()))
    .get();

  if (!user) {
    await verifyAgainstDummy(input.password);
    return { ok: false, reason: "invalid" };
  }
  if (user.lockedAt) return { ok: false, reason: "locked" };

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!user.active) return { ok: false, reason: "invalid" };

  if (valid) {
    if (user.failedLoginCount > 0) {
      db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id)).run();
    }
    return { ok: true, userId: user.id };
  }

  const lockoutAttempts = getSetting("auth.loginLockoutAttempts", {}, db);
  return db.transaction((tx) => {
    const { failedLoginCount } = tx
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, user.id))
      .returning({ failedLoginCount: users.failedLoginCount })
      .get();

    if (lockoutAttempts > 0 && failedLoginCount >= lockoutAttempts) {
      tx.update(users).set({ lockedAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(users.id, user.id)).run();
      writeAudit(
        tx,
        {
          actorUserId: null,
          roleUsed: null,
          action: "user.lock",
          entityType: "user",
          entityId: user.id,
          after: { failedLoginCount },
          reason: "failed-login lockout",
        },
        now,
      );
      return { ok: false, reason: "locked" } as const;
    }
    return { ok: false, reason: "invalid" } as const;
  });
}
