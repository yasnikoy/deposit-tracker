import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { JobKind } from "@/domain/records";
import { APP_VERSION } from "@/lib/version";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { backupStatus, type BackupStatus } from "./backups";
import { DATABASE_FILE_NAME, type Db } from "./db/client";
import { jobs, mailboxState, serviceStatus } from "./db/schema";
import { getEnv } from "./env";
import { appBaseUrl, lanAddresses } from "./network";

/** The public probe `start.cmd` uses after an update: the app answers and the database reads. */
export function probe(db: Db): { ok: true; version: string } {
  db.$client.prepare("SELECT 1").get();
  return { ok: true, version: APP_VERSION };
}

export type SystemHealth = {
  version: string;
  startedAt: string;
  address: string;
  otherAddresses: string[];
  dataDir: string;
  emailMode: string;
  databaseBytes: number;
  diskFreeBytes: number | null;
  jobs: { pending: number; failedRecently: { kind: JobKind; at: string; error: string }[] };
  mail: { service: string; failingSince: string | null; lastError: string | null; lastOkAt: string | null }[];
  lastMailboxPollAt: string | null;
  backups: BackupStatus;
};

const sizeOf = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

/** The admin health page (ARCHITECTURE → Operations → Health). */
export function systemHealth(db: Db, actor: AuthUser, now: Date = new Date()): SystemHealth {
  authorize(actor, "system.view");
  const env = getEnv();
  const dbFile = path.join(env.dataDir, DATABASE_FILE_NAME);
  let diskFreeBytes: number | null = null;
  try {
    const stat = fs.statfsSync(env.dataDir);
    diskFreeBytes = stat.bavail * stat.bsize;
  } catch {
    // Not available on every file system; the page shows "—".
  }
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [address, ...otherAddresses] = [appBaseUrl(), ...lanAddresses().slice(1).map((a) => `http://${a}:${process.env.PORT ?? "3000"}`)];
  return {
    version: APP_VERSION,
    startedAt: new Date(now.getTime() - process.uptime() * 1000).toISOString(),
    address,
    otherAddresses,
    dataDir: env.dataDir,
    emailMode: env.EMAIL_MODE,
    databaseBytes: sizeOf(dbFile) + sizeOf(`${dbFile}-wal`),
    diskFreeBytes,
    jobs: {
      pending: db.select({ n: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, "PENDING")).get()?.n ?? 0,
      failedRecently: db
        .select({ kind: jobs.kind, at: jobs.updatedAt, error: jobs.lastError })
        .from(jobs)
        .where(and(eq(jobs.status, "FAILED"), gte(jobs.updatedAt, weekAgo)))
        .orderBy(desc(jobs.updatedAt))
        .limit(10)
        .all()
        .map((j) => ({ ...j, error: j.error ?? "" })),
    },
    mail: db.select().from(serviceStatus).all(),
    lastMailboxPollAt: db.select({ at: sql<string | null>`max(${mailboxState.lastPolledAt})` }).from(mailboxState).get()?.at ?? null,
    backups: backupStatus(db, env.dataDir),
  };
}
