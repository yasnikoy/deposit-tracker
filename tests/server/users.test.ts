import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { attemptLogin } from "@/server/auth/login";
import { createSession, findSession } from "@/server/auth/session";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { auditLog, sessions, users } from "@/server/db/schema";
import { DomainError, ForbiddenError } from "@/server/errors";
import {
  changeOwnPassword,
  createUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  unlockUser,
  updateUser,
} from "@/server/users";
import { createTestDb, makeUser, TEST_PASSWORD } from "../support/db";

let db: Db;
let admin: AuthUser;
beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
});

const errorKey = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).messageKey;
  }
  return null;
};
const activeSessions = (userId: number) =>
  db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).all();

describe("user management", () => {
  it("creates a user with a temporary password and audits it under the admin role", async () => {
    const id = await createUser(db, admin, {
      username: "ayse",
      displayName: "Ayşe",
      roles: ["OPERATIONS", "ACCOUNTANT"],
      password: TEST_PASSWORD,
    });
    const listed = listUsers(db, admin).find((u) => u.id === id);
    expect(listed).toMatchObject({ roles: ["ACCOUNTANT", "OPERATIONS"], mustChangePassword: true, active: true });

    const audit = db.select().from(auditLog).where(and(eq(auditLog.action, "user.create"), eq(auditLog.entityId, String(id)))).get();
    expect(audit).toMatchObject({ actorUserId: admin.id, roleUsed: "ADMIN" });
    expect(JSON.stringify(audit)).not.toContain("argon2");
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    await expect(
      createUser(db, admin, { username: "ADMIN", displayName: "x", roles: ["ADMIN"], password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ messageKey: "users.errors.usernameTaken" });
  });

  it("forbids non-admins from managing users", async () => {
    const ops = await makeUser(db, "ops", ["OPERATIONS", "ACCOUNTANT"]);
    expect(() => listUsers(db, ops)).toThrow(ForbiddenError);
    await expect(
      createUser(db, ops, { username: "x1", displayName: "x", roles: ["ADMIN"], password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps at least one active admin", async () => {
    expect(errorKey(() => updateUser(db, admin, { userId: admin.id, displayName: "A", roles: ["OPERATIONS"] }))).toBe(
      "users.errors.lastAdmin",
    );
    const second = await makeUser(db, "admin2", ["ADMIN"]);
    updateUser(db, admin, { userId: admin.id, displayName: "A", roles: ["ADMIN", "OPERATIONS"] });
    expect(errorKey(() => setUserActive(db, admin, { userId: admin.id, active: false }))).toBe("users.errors.selfDeactivate");

    setUserActive(db, second, { userId: admin.id, active: false });
    expect(errorKey(() => updateUser(db, second, { userId: second.id, displayName: "B", roles: ["OPERATIONS"] }))).toBe(
      "users.errors.lastAdmin",
    );
  });

  it("deactivation ends the user's sessions; reactivation restores login", async () => {
    const ops = await makeUser(db, "ops", ["OPERATIONS"]);
    const token = createSession(db, ops.id);
    setUserActive(db, admin, { userId: ops.id, active: false });
    expect(findSession(db, token)).toBeNull();
    expect(activeSessions(ops.id)).toHaveLength(0);

    setUserActive(db, admin, { userId: ops.id, active: true });
    expect((await attemptLogin(db, { username: "ops", password: TEST_PASSWORD })).ok).toBe(true);
    const actions = db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, String(ops.id))).all();
    expect(actions.map((r) => r.a)).toEqual(["user.create", "user.deactivate", "user.reactivate"]);
  });

  it("password reset unlocks, forces a change and ends sessions", async () => {
    const ops = await makeUser(db, "ops", ["OPERATIONS"]);
    createSession(db, ops.id);
    for (let i = 0; i < 5; i++) await attemptLogin(db, { username: "ops", password: "wrong" });
    expect(db.select().from(users).where(eq(users.id, ops.id)).get()?.lockedAt).not.toBeNull();

    await resetUserPassword(db, admin, { userId: ops.id, temporaryPassword: "temporary-123" });
    const row = db.select().from(users).where(eq(users.id, ops.id)).get();
    expect(row).toMatchObject({ lockedAt: null, failedLoginCount: 0, mustChangePassword: true });
    expect(activeSessions(ops.id)).toHaveLength(0);
    expect((await attemptLogin(db, { username: "ops", password: "temporary-123" })).ok).toBe(true);
  });

  it("unlock clears the lock without touching the password", async () => {
    const ops = await makeUser(db, "ops", ["OPERATIONS"]);
    for (let i = 0; i < 5; i++) await attemptLogin(db, { username: "ops", password: "wrong" });
    unlockUser(db, admin, { userId: ops.id });
    expect((await attemptLogin(db, { username: "ops", password: TEST_PASSWORD })).ok).toBe(true);
  });

  it("own password change keeps the current session and ends the others", async () => {
    const ops = await makeUser(db, "ops", ["OPERATIONS"], { mustChangePassword: true });
    const current = findSession(db, createSession(db, ops.id))!;
    const otherToken = createSession(db, ops.id);

    await expect(
      changeOwnPassword(db, current, { currentPassword: "nope", newPassword: "new-password-1" }),
    ).rejects.toMatchObject({ messageKey: "auth.changePassword.wrongCurrent" });
    await expect(
      changeOwnPassword(db, current, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD }),
    ).rejects.toMatchObject({ messageKey: "auth.changePassword.sameAsOld" });

    await changeOwnPassword(db, current, { currentPassword: TEST_PASSWORD, newPassword: "new-password-1" });
    expect(findSession(db, otherToken)).toBeNull();
    expect(activeSessions(ops.id).map((s) => s.id)).toEqual([current.sessionId]);
    expect(db.select().from(users).where(eq(users.id, ops.id)).get()?.mustChangePassword).toBe(false);
  });
});
