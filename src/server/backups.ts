import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { backupsToKeep } from "@/domain/backup-retention";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { istanbulToday, type IsoDate } from "@/domain/business-days";
import type { Db, DbOrTx } from "./db/client";
import { jobs } from "./db/schema";
import { logger } from "./logger";
import { getSetting } from "./settings";

/** Daily copies are named by their business date; only these are ever pruned. */
const DAILY = /^deposit-(\d{4}-\d{2}-\d{2})\.sqlite$/;
/** The folder created in the second location (a share or a USB disk). */
export const SECOND_LOCATION_FOLDER = "deposit-tracker-backups";

export type BackupTarget = { dir: string; file: string; filesCopied: number; pruned: number };
export type BackupResult = { date: IsoDate; local: BackupTarget; second: BackupTarget | { error: string } | null };

/** Writes `src` to `dest` through a temporary name, so a half-written copy never looks complete. */
function copyAtomically(src: string, dest: string): void {
  const tmp = `${dest}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

/** Uploaded files never change once stored, so copying the new ones keeps the mirror complete. */
function mirrorFiles(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(/*turbopackIgnore: true*/ from, entry.name);
    const dest = path.join(/*turbopackIgnore: true*/ to, entry.name);
    if (entry.isDirectory()) {
      copied += mirrorFiles(src, dest);
    } else if (entry.isFile() && (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(src).size)) {
      fs.mkdirSync(to, { recursive: true });
      copyAtomically(src, dest);
      copied++;
    }
  }
  return copied;
}

function prune(dailyDir: string, counts: { keepDaily: number; keepWeekly: number }): number {
  const copies = fs.readdirSync(dailyDir).flatMap((name) => {
    const m = DAILY.exec(name);
    return m ? [{ name, date: m[1] }] : [];
  });
  const keep = backupsToKeep(
    copies.map((c) => c.date),
    counts,
  );
  const old = copies.filter((c) => !keep.has(c.date));
  for (const c of old) fs.rmSync(path.join(/*turbopackIgnore: true*/ dailyDir, c.name));
  return old.length;
}

/** One backup target: today's database copy, the mirrored files folder, old copies pruned. */
function writeTarget(dir: string, snapshot: string, filesFrom: string, counts: { keepDaily: number; keepWeekly: number }): BackupTarget {
  const dailyDir = path.join(/*turbopackIgnore: true*/ dir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const file = path.join(/*turbopackIgnore: true*/ dailyDir, path.basename(snapshot));
  if (path.resolve(file) !== path.resolve(snapshot)) copyAtomically(snapshot, file);
  const filesCopied = mirrorFiles(filesFrom, path.join(/*turbopackIgnore: true*/ dir, "files"));
  return { dir, file, filesCopied, pruned: prune(dailyDir, counts) };
}

/**
 * The daily backup (ARCHITECTURE → Operations → Backups): a consistent SQLite copy (online
 * backup, safe while the app runs) and a mirror of the uploaded files, in the data folder's
 * `backups` and, when set, in the second location. A failing second location does not fail
 * the local backup; it is reported. The key file is never backed up here (rule 14).
 */
export async function runBackup(db: Db, dataDir: string, now: Date = new Date()): Promise<BackupResult> {
  const date = istanbulToday(now);
  const counts = { keepDaily: getSetting("backups.keepDaily", {}, db), keepWeekly: getSetting("backups.keepWeekly", {}, db) };
  const localDir = path.join(/*turbopackIgnore: true*/ dataDir, "backups");
  const filesDir = path.join(/*turbopackIgnore: true*/ dataDir, "files");
  fs.mkdirSync(path.join(/*turbopackIgnore: true*/ localDir, "daily"), { recursive: true });
  const snapshot = path.join(/*turbopackIgnore: true*/ localDir, "daily", `deposit-${date}.sqlite`);
  await db.$client.backup(`${snapshot}.tmp`);
  fs.renameSync(`${snapshot}.tmp`, snapshot);
  const local = writeTarget(localDir, snapshot, filesDir, counts);

  let second: BackupResult["second"] = null;
  const secondLocation = getSetting("backups.secondLocation", {}, db).trim();
  if (secondLocation) {
    try {
      if (!fs.existsSync(secondLocation)) throw new Error(`not reachable: ${secondLocation}`);
      second = writeTarget(path.join(/*turbopackIgnore: true*/ secondLocation, SECOND_LOCATION_FOLDER), snapshot, filesDir, counts);
    } catch (error) {
      second = { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }
  logger.info({ date, local, second }, "backup written");
  return { date, local, second };
}

export type BackupCopy = { date: IsoDate; at: string; sizeBytes: number };
export type BackupStatus = {
  local: BackupCopy | null;
  second: { location: string; latest: BackupCopy | null; reachable: boolean } | null;
  lastFailure: { at: string; error: string } | null;
  nextRunAt: string | null;
};

function latestCopy(dailyDir: string): BackupCopy | null {
  if (!fs.existsSync(dailyDir)) return null;
  const latest = fs
    .readdirSync(dailyDir)
    .map((name) => DAILY.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => b[1].localeCompare(a[1]))[0];
  if (!latest) return null;
  const stat = fs.statSync(path.join(/*turbopackIgnore: true*/ dailyDir, latest[0]));
  return { date: latest[1], at: stat.mtime.toISOString(), sizeBytes: stat.size };
}

/** What the health page shows: the newest copies as they are on disk, the last failure, the next run. */
export function backupStatus(db: DbOrTx, dataDir: string): BackupStatus {
  const location = getSetting("backups.secondLocation", {}, db).trim();
  const reachable = location !== "" && fs.existsSync(location);
  const failed = db
    .select({ at: jobs.updatedAt, error: jobs.lastError })
    .from(jobs)
    .where(and(eq(jobs.kind, "BACKUP"), eq(jobs.status, "FAILED")))
    .orderBy(desc(jobs.updatedAt))
    .get();
  const next = db
    .select({ runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.kind, "BACKUP"), eq(jobs.status, "PENDING")))
    .orderBy(jobs.runAt)
    .get();
  const local = latestCopy(path.join(/*turbopackIgnore: true*/ dataDir, "backups", "daily"));
  return {
    local,
    second: location ? { location, reachable, latest: reachable ? latestCopy(path.join(/*turbopackIgnore: true*/ location, SECOND_LOCATION_FOLDER, "daily")) : null } : null,
    // A failure older than the newest copy is history, not a problem.
    lastFailure: failed && (!local || failed.at > local.at) ? { at: failed.at, error: failed.error ?? "" } : null,
    nextRunAt: next?.runAt ?? null,
  };
}

/** "Şimdi yedekle" on the health page: the same backup as the daily one, started by an admin. */
export async function runBackupNow(db: Db, actor: AuthUser, dataDir: string, now: Date = new Date()): Promise<BackupResult> {
  authorize(actor, "backup.run");
  const result = await runBackup(db, dataDir, now);
  logger.info({ actorUserId: actor.id }, "backup started by hand");
  return result;
}
