import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { countPendingMigrations, migrateWithBackup } from "@/server/db/migrate";
import { MIGRATIONS } from "../../support/db";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-migrate-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Copy of the real migrations plus one extra migration, to simulate an app update. */
function migrationsWithExtraStep(): string {
  const folder = path.join(dir, "migrations");
  fs.cpSync(MIGRATIONS, folder, { recursive: true });
  const journalFile = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "9999_test_extra" });
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  fs.writeFileSync(path.join(folder, "9999_test_extra.sql"), "CREATE TABLE test_extra (id integer);");
  return folder;
}

describe("migrateWithBackup", () => {
  it("migrates a fresh database without a backup", async () => {
    const db = openDatabase(path.join(dir, "fresh.sqlite"));
    const result = await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    expect(result.applied).toBeGreaterThan(0);
    expect(result.backupFile).toBeNull();
    expect(countPendingMigrations(db, MIGRATIONS)).toBe(0);
  });

  it("backs up an existing database before applying pending migrations", async () => {
    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });

    const updated = migrationsWithExtraStep();
    const result = await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: updated });
    expect(result.applied).toBe(1);
    expect(result.backupFile).not.toBeNull();

    const backup = openDatabase(result.backupFile!);
    const tables = (sql: string) => backup.$client.prepare(sql).all();
    expect(tables("SELECT name FROM sqlite_master WHERE name = 'users'")).toHaveLength(1);
    expect(tables("SELECT name FROM sqlite_master WHERE name = 'test_extra'")).toHaveLength(0);
  });

  it("does nothing when no migration is pending", async () => {
    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    expect(await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS })).toEqual({
      applied: 0,
      backupFile: null,
    });
  });
});
