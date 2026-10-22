import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { attemptLogin } from "@/server/auth/login";
import type { Db } from "@/server/db/client";
import { auditLog, settings, users } from "@/server/db/schema";
import { setUserActive } from "@/server/users";
import { createTestDb, makeUser, TEST_PASSWORD } from "../../support/db";

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const fail = (username = "ali") => attemptLogin(db, { username, password: "wrong" });

describe("attemptLogin", () => {
  it("accepts the right password, case-insensitive username", async () => {
    const ali = await makeUser(db, "Ali", ["OPERATIONS"]);
    expect(await attemptLogin(db, { username: "ALI", password: TEST_PASSWORD })).toEqual({ ok: true, userId: ali.id });
  });

  it("answers invalid for unknown users and wrong passwords alike", async () => {
    await makeUser(db, "ali", ["OPERATIONS"]);
    expect(await attemptLogin(db, { username: "nobody", password: TEST_PASSWORD })).toEqual({ ok: false, reason: "invalid" });
    expect(await fail()).toEqual({ ok: false, reason: "invalid" });
  });

  it("answers invalid for a deactivated user even with the right password", async () => {
    const admin = await makeUser(db, "admin", ["ADMIN"]);
    const ali = await makeUser(db, "ali", ["OPERATIONS"]);
    setUserActive(db, admin, { userId: ali.id, active: false });
    expect(await attemptLogin(db, { username: "ali", password: TEST_PASSWORD })).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks after the configured number of failures and stays locked", async () => {
    const ali = await makeUser(db, "ali", ["OPERATIONS"]);
    for (let i = 0; i < 4; i++) expect((await fail()).ok).toBe(false);
    expect(await fail()).toEqual({ ok: false, reason: "locked" });
    expect(await attemptLogin(db, { username: "ali", password: TEST_PASSWORD })).toEqual({ ok: false, reason: "locked" });

    const audit = db.select().from(auditLog).where(eq(auditLog.action, "user.lock")).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: null, entityId: String(ali.id) });
  });

  it("resets the failure count after a successful login", async () => {
    await makeUser(db, "ali", ["OPERATIONS"]);
    for (let i = 0; i < 4; i++) await fail();
    expect((await attemptLogin(db, { username: "ali", password: TEST_PASSWORD })).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect(await fail()).toEqual({ ok: false, reason: "invalid" });
  });

  it("never locks when the setting is 0", async () => {
    await makeUser(db, "ali", ["OPERATIONS"]);
    db.update(settings).set({ value: 0 }).where(eq(settings.key, "auth.loginLockoutAttempts")).run();
    for (let i = 0; i < 10; i++) expect(await fail()).toEqual({ ok: false, reason: "invalid" });
    expect(db.select().from(users).get()?.lockedAt).toBeNull();
  });
});
