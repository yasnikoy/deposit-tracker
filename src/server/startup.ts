import "server-only";
import path from "node:path";
import { getDb } from "./db/client";
import { migrateWithBackup } from "./db/migrate";
import { getEnv } from "./env";
import { acquireInstanceLock } from "./instance-lock";
import { enableFileLogging, logger } from "./logger";
import { seedLists } from "./lists";
import { seedSettings } from "./settings";

/** Prepares the database: migrations (after an automatic backup) and seed values. */
export async function prepareDatabase(): Promise<void> {
  const { dataDir } = getEnv();
  await enableFileLogging();
  const db = getDb();
  const result = await migrateWithBackup(db, { backupDir: path.join(/*turbopackIgnore: true*/ dataDir, "backups") });
  if (result.applied > 0) {
    logger.info({ applied: result.applied, backupFile: result.backupFile }, "database migrated");
  }
  const seeded = seedSettings(db);
  if (seeded.length > 0) logger.info({ keys: seeded }, "settings seeded");
  const currencies = seedLists(db);
  if (currencies.length > 0) logger.info({ currencies }, "lists seeded");
}

/** Runs once per server process, before the first request is handled. */
export async function startServer(): Promise<void> {
  const env = getEnv();
  acquireInstanceLock(env.dataDir);
  await prepareDatabase();
  logger.info({ dataDir: env.dataDir, emailMode: env.EMAIL_MODE }, "server started");
}
