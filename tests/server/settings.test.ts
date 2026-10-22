import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, settings, settingsHistory } from "@/server/db/schema";
import { getSetting, seedSettings } from "@/server/settings";
import { createTestDb } from "../support/db";

describe("settings seed", () => {
  it("loads seed values, with history and audit rows", () => {
    const db = createTestDb();
    expect(getSetting("auth.loginLockoutAttempts", {}, db)).toBe(5);
    expect(db.select().from(settingsHistory).all().length).toBeGreaterThan(0);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "settings.seed")).all().length).toBeGreaterThan(0);
  });

  it("never overwrites a value changed after install", () => {
    const db = createTestDb();
    db.update(settings).set({ value: 9 }).where(eq(settings.key, "auth.loginLockoutAttempts")).run();
    expect(seedSettings(db, path.resolve("seed/settings.json"))).toEqual([]);
    expect(getSetting("auth.loginLockoutAttempts", {}, db)).toBe(9);
  });

  it("rejects unknown keys and invalid values in the seed file", () => {
    const db = createTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-seed-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ settings: { "no.such.key": 1 } }));
    expect(() => seedSettings(db, file)).toThrow(/Unknown setting/);
    fs.writeFileSync(file, JSON.stringify({ settings: { "auth.minPasswordLength": -1 } }));
    expect(() => seedSettings(db, file)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
