import "server-only";
import path from "node:path";
import { getDb } from "./db/client";
import { migrateWithBackup } from "./db/migrate";
import { getEnv } from "./env";
import { acquireInstanceLock } from "./instance-lock";
import { recoverInterruptedJobs, startScheduler } from "./jobs";
import { enableFileLogging, logger } from "./logger";
import { emailJobHandlers } from "./email/send";
import { seedEmailTemplates } from "./email/templates";
import { mailboxFromSettings } from "./email/mailbox";
import { mailTransport } from "./email/transport";
import { ensureRecurringJobs, recurringJobHandlers } from "./recurring-jobs";
import { seedLists, seedReplyTypes } from "./lists";
import { resolveKeyFile } from "./secrets";
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
  const replyTypeCodes = seedReplyTypes(db);
  if (replyTypeCodes.length > 0) logger.info({ replyTypes: replyTypeCodes }, "reply types seeded");
  const templates = seedEmailTemplates(db);
  if (templates.length > 0) logger.info({ templates }, "email templates seeded");
}

/** Runs once per server process, before the first request is handled. */
export async function startServer(): Promise<void> {
  const env = getEnv();
  acquireInstanceLock(env.dataDir);
  // Fails early if KEY_FILE points inside the data folder.
  resolveKeyFile(env);
  await prepareDatabase();
  const db = getDb();
  const recovered = recoverInterruptedJobs(db);
  if (recovered > 0) logger.warn({ recovered }, "jobs interrupted by a restart will run again");
  ensureRecurringJobs(db);
  const transport = () => mailTransport(db);
  startScheduler(db, {
    ...emailJobHandlers(db, transport),
    ...recurringJobHandlers(db, { mailbox: () => mailboxFromSettings(db), transport }),
  });
  logger.info({ dataDir: env.dataDir, emailMode: env.EMAIL_MODE }, "server started");
}
