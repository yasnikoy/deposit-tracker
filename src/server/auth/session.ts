import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { sessions, users } from "../db/schema";
import { loadRoles } from "../user-roles";
import type { AuthSession } from "./types";

export const SESSION_COOKIE = "dt_session";
const TOUCH_INTERVAL_MS = 60_000;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a session and returns the raw token for the cookie; only its hash is stored. */
export function createSession(db: DbOrTx, userId: number, now: Date = new Date()): string {
  const token = randomBytes(32).toString("base64url");
  const at = now.toISOString();
  db.insert(sessions).values({ id: hashSessionToken(token), userId, createdAt: at, lastSeenAt: at }).run();
  return token;
}

/** Sessions have no idle timeout; they end on logout, deactivation or a password change/reset. */
export function findSession(db: DbOrTx, token: string, now: Date = new Date()): AuthSession | null {
  const sessionId = hashSessionToken(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), eq(users.active, true)))
    .get();
  if (!row) return null;

  if (now.getTime() - Date.parse(row.session.lastSeenAt) > TOUCH_INTERVAL_MS) {
    db.update(sessions).set({ lastSeenAt: now.toISOString() }).where(eq(sessions.id, sessionId)).run();
  }
  return {
    sessionId,
    user: {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      roles: loadRoles(db, row.user.id),
      active: row.user.active,
      mustChangePassword: row.user.mustChangePassword,
    },
  };
}

export function revokeSession(db: DbOrTx, sessionId: string, now: Date = new Date()): void {
  db.update(sessions)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .run();
}

export function revokeUserSessions(
  db: DbOrTx,
  userId: number,
  now: Date = new Date(),
  exceptSessionId?: string,
): void {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
  db.update(sessions).set({ revokedAt: now.toISOString() }).where(and(...conditions)).run();
}
