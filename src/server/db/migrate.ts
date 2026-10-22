import "server-only";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

type Journal = { entries: { idx: number; tag: string }[] };

export function countPendingMigrations(db: Db, migrationsFolder = MIGRATIONS_FOLDER): number {
  const journal = JSON.parse(
    fs.readFileSync(/*turbopackIgnore: true*/ path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const hasTable = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const applied = hasTable
    ? (db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n
    : 0;
  return Math.max(0, journal.entries.length - applied);
}

function isEmptyDatabase(db: Db): boolean {
  return !db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
}

/**
 * Rule 15: migrations run on start only after an automatic backup.
 * A brand-new, empty database has nothing to back up.
 */
export async function migrateWithBackup(
  db: Db,
  options: { backupDir: string; migrationsFolder?: string; now?: Date },
): Promise<{ applied: number; backupFile: string | null }> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const pending = countPendingMigrations(db, migrationsFolder);
  if (pending === 0) return { applied: 0, backupFile: null };

  let backupFile: string | null = null;
  if (!isEmptyDatabase(db)) {
    fs.mkdirSync(options.backupDir, { recursive: true });
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backupFile = path.join(/*turbopackIgnore: true*/ options.backupDir, `pre-migration-${stamp}.sqlite`);
    await db.$client.backup(backupFile);
  }
  migrate(db, { migrationsFolder });
  return { applied: pending, backupFile };
}
