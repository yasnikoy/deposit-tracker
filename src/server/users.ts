import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Role } from "@/domain/roles";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import { hashPassword, verifyPassword } from "./auth/password";
import { revokeUserSessions } from "./auth/session";
import type { AuthSession, AuthUser } from "./auth/types";
import type { Db, DbOrTx, Tx } from "./db/client";
import { userRoles, users } from "./db/schema";
import { DomainError } from "./errors";
import { getSetting } from "./settings";
import { loadRoles, sortRoles } from "./user-roles";

export type UserListItem = {
  id: number;
  username: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  createdAt: string;
};

function usernameTaken(tx: DbOrTx, username: string): boolean {
  return !!tx
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
    .get();
}

function requireUserRow(tx: DbOrTx, userId: number) {
  const row = tx.select().from(users).where(eq(users.id, userId)).get();
  if (!row) throw new DomainError("errors.notFound");
  return row;
}

/** Active admins other than `userId`; used to keep at least one active admin at all times. */
function otherActiveAdminCount(tx: DbOrTx, userId: number): number {
  const row = tx
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, "ADMIN")))
    .where(and(eq(users.active, true), ne(users.id, userId)))
    .get();
  return row?.n ?? 0;
}

function replaceRoles(tx: Tx, userId: number, roles: Role[]): void {
  tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();
  tx.insert(userRoles).values(roles.map((role) => ({ userId, role }))).run();
}

function snapshot(row: typeof users.$inferSelect, roles: Role[]) {
  return {
    username: row.username,
    displayName: row.displayName,
    roles,
    active: row.active,
    locked: row.lockedAt !== null,
    mustChangePassword: row.mustChangePassword,
  };
}

export function minPasswordLength(db: DbOrTx): number {
  return getSetting("auth.minPasswordLength", {}, db);
}

export function listUsers(db: Db, actor: AuthUser): UserListItem[] {
  authorize(actor, "user.list");
  const rows = db.select().from(users).orderBy(asc(sql`lower(${users.username})`)).all();
  const roleRows = db.select().from(userRoles).all();
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    roles: sortRoles(roleRows.filter((r) => r.userId === row.id).map((r) => r.role)),
    active: row.active,
    locked: row.lockedAt !== null,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt,
  }));
}

/**
 * Creates a user. `actor` null means the create-admin script (system action).
 * The password is temporary (must be changed at first login) unless `mustChangePassword` is false.
 */
export async function createUser(
  db: Db,
  actor: AuthUser | null,
  input: { username: string; displayName: string; roles: Role[]; password: string; mustChangePassword?: boolean },
  now: Date = new Date(),
): Promise<number> {
  const roleUsed = actor ? authorize(actor, "user.create") : null;
  const passwordHash = await hashPassword(input.password);
  const at = now.toISOString();

  return db.transaction((tx) => {
    if (usernameTaken(tx, input.username)) throw new DomainError("users.errors.usernameTaken");
    const row = tx
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        mustChangePassword: input.mustChangePassword ?? true,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    const roles = sortRoles(input.roles);
    replaceRoles(tx, row.id, roles);
    writeAudit(
      tx,
      {
        actorUserId: actor?.id ?? null,
        roleUsed,
        action: "user.create",
        entityType: "user",
        entityId: row.id,
        after: snapshot(row, roles),
        reason: actor ? null : "create-admin script",
      },
      now,
    );
    return row.id;
  });
}

export function updateUser(
  db: Db,
  actor: AuthUser,
  input: { userId: number; displayName: string; roles: Role[] },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "user.update");
  db.transaction((tx) => {
    const before = requireUserRow(tx, input.userId);
    const beforeRoles = loadRoles(tx, input.userId);
    const roles = sortRoles(input.roles);
    const losesAdmin = beforeRoles.includes("ADMIN") && !roles.includes("ADMIN");
    if (losesAdmin && before.active && otherActiveAdminCount(tx, input.userId) === 0) {
      throw new DomainError("users.errors.lastAdmin");
    }
    const after = tx
      .update(users)
      .set({ displayName: input.displayName, updatedAt: now.toISOString() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    replaceRoles(tx, input.userId, roles);
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "user.update",
        entityType: "user",
        entityId: input.userId,
        before: snapshot(before, beforeRoles),
        after: snapshot(after, roles),
      },
      now,
    );
  });
}

/** Users are deactivated, never deleted; deactivation ends their sessions. */
export function setUserActive(
  db: Db,
  actor: AuthUser,
  input: { userId: number; active: boolean },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "user.setActive");
  db.transaction((tx) => {
    const before = requireUserRow(tx, input.userId);
    if (before.active === input.active) return;
    const roles = loadRoles(tx, input.userId);
    if (!input.active) {
      if (input.userId === actor.id) throw new DomainError("users.errors.selfDeactivate");
      if (roles.includes("ADMIN") && otherActiveAdminCount(tx, input.userId) === 0) {
        throw new DomainError("users.errors.lastAdmin");
      }
      revokeUserSessions(tx, input.userId, now);
    }
    const after = tx
      .update(users)
      .set({ active: input.active, updatedAt: now.toISOString() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: input.active ? "user.reactivate" : "user.deactivate",
        entityType: "user",
        entityId: input.userId,
        before: snapshot(before, roles),
        after: snapshot(after, roles),
      },
      now,
    );
  });
}

/** Admin sets a temporary password: forces a change at next login, unlocks, ends sessions. */
export async function resetUserPassword(
  db: Db,
  actor: AuthUser,
  input: { userId: number; temporaryPassword: string },
  now: Date = new Date(),
): Promise<void> {
  const roleUsed = authorize(actor, "user.resetPassword");
  const passwordHash = await hashPassword(input.temporaryPassword);
  db.transaction((tx) => {
    const before = requireUserRow(tx, input.userId);
    const roles = loadRoles(tx, input.userId);
    const after = tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedAt: null, updatedAt: now.toISOString() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    revokeUserSessions(tx, input.userId, now);
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "user.resetPassword",
        entityType: "user",
        entityId: input.userId,
        before: snapshot(before, roles),
        after: snapshot(after, roles),
      },
      now,
    );
  });
}

export function unlockUser(db: Db, actor: AuthUser, input: { userId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "user.unlock");
  db.transaction((tx) => {
    const before = requireUserRow(tx, input.userId);
    if (!before.lockedAt) return;
    const roles = loadRoles(tx, input.userId);
    const after = tx
      .update(users)
      .set({ failedLoginCount: 0, lockedAt: null, updatedAt: now.toISOString() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "user.unlock",
        entityType: "user",
        entityId: input.userId,
        before: snapshot(before, roles),
        after: snapshot(after, roles),
      },
      now,
    );
  });
}

/** Own password change; other sessions of the user are ended, the current one stays. */
export async function changeOwnPassword(
  db: Db,
  session: AuthSession,
  input: { currentPassword: string; newPassword: string },
  now: Date = new Date(),
): Promise<void> {
  const roleUsed = authorize(session.user, "auth.changeOwnPassword");
  const row = requireUserRow(db, session.user.id);
  if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
    throw new DomainError("auth.changePassword.wrongCurrent");
  }
  if (input.currentPassword === input.newPassword) throw new DomainError("auth.changePassword.sameAsOld");
  const passwordHash = await hashPassword(input.newPassword);

  db.transaction((tx) => {
    tx.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: now.toISOString() })
      .where(eq(users.id, session.user.id))
      .run();
    revokeUserSessions(tx, session.user.id, now, session.sessionId);
    writeAudit(
      tx,
      { actorUserId: session.user.id, roleUsed, action: "user.changePassword", entityType: "user", entityId: session.user.id },
      now,
    );
  });
}
