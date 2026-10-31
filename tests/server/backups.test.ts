import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCalendarDays } from "@/domain/business-days";
import type { AuthUser } from "@/server/auth/types";
import { backupStatus, runBackup, SECOND_LOCATION_FOLDER } from "@/server/backups";
import type { Db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { ensureRecurringJobs } from "@/server/recurring-jobs";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";

// Saturday 31 Oct 2026, 15:00 Istanbul: after the default 12:30 backup time.
const NOW = new Date("2026-10-31T12:00:00Z");

let db: Db;
let admin: AuthUser;
let dataDir: string;
let elsewhere: string;

const set = (key: string, value: unknown) => updateSettings(db, admin, { changes: [{ key, value }] }, NOW);
const write = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-data-"));
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-share-"));
  write(dataDir, "files/2026/10/a.pdf", "receipt");
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

describe("daily backup", () => {
  it("writes a readable database copy and mirrors the files, locally and in the second location", async () => {
    set("backups.secondLocation", elsewhere);
    const result = await runBackup(db, dataDir, NOW);
    expect(result.local.file).toBe(path.join(dataDir, "backups", "daily", "deposit-2026-10-31.sqlite"));
    const copy = new Database(result.local.file, { readonly: true });
    expect(copy.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
    copy.close();
    expect(fs.readFileSync(path.join(dataDir, "backups", "files", "2026", "10", "a.pdf"), "utf8")).toBe("receipt");
    const second = path.join(elsewhere, SECOND_LOCATION_FOLDER);
    expect(fs.existsSync(path.join(second, "daily", "deposit-2026-10-31.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(second, "files", "2026", "10", "a.pdf"))).toBe(true);

    // Only new files are copied the next time.
    write(dataDir, "files/2026/10/b.pdf", "invoice");
    const again = await runBackup(db, dataDir, NOW);
    expect(again.local.filesCopied).toBe(1);
  });

  it("keeps the local backup when the second location is unreachable, and reports it", async () => {
    set("backups.secondLocation", path.join(elsewhere, "missing-share"));
    const result = await runBackup(db, dataDir, NOW);
    expect(fs.existsSync(result.local.file)).toBe(true);
    expect(result.second).toEqual({ error: expect.stringContaining("not reachable") });
    expect(backupStatus(db, dataDir)).toMatchObject({ local: { date: "2026-10-31" }, second: { reachable: false, latest: null } });
  });

  it("prunes old daily copies by the retention settings", async () => {
    set("backups.keepDaily", 2);
    set("backups.keepWeekly", 0);
    const daily = path.join(dataDir, "backups", "daily");
    for (let i = 1; i <= 5; i++) write(daily, `deposit-${addCalendarDays("2026-10-31", -i)}.sqlite`, "old");
    write(daily, "pre-migration-copy.sqlite", "kept: not a daily copy");
    const result = await runBackup(db, dataDir, NOW);
    expect(result.local.pruned).toBe(4);
    expect(fs.readdirSync(daily).sort()).toEqual(["deposit-2026-10-30.sqlite", "deposit-2026-10-31.sqlite", "pre-migration-copy.sqlite"]);
  });

  it("is scheduled at the backup time, and a missed one runs at start", () => {
    ensureRecurringJobs(db, NOW);
    const backup = db.select().from(jobs).where(and(eq(jobs.kind, "BACKUP"), eq(jobs.status, "PENDING"))).get()!;
    // 12:30 today has passed and nothing ran today: due now (caught up), unlike the daily email.
    expect(backup.payload).toEqual({ date: "2026-10-31" });
    expect(backup.runAt).toBe("2026-10-31T09:30:00.000Z");
  });
});
