import "server-only";
import { and, asc, eq, lte } from "drizzle-orm";
import type { JobKind } from "@/domain/records";
import type { Db, DbOrTx } from "./db/client";
import { jobs } from "./db/schema";
import { logger } from "./logger";

export type Job = typeof jobs.$inferSelect;

/** What a handler decides: done, try again later, or give up. */
export type JobOutcome = { status: "done" } | { status: "retry"; at: Date; error: string } | { status: "failed"; error: string };
export type JobHandler = (job: Job, now: Date) => Promise<JobOutcome>;
export type JobHandlers = Record<JobKind, JobHandler>;

export function enqueueJob(tx: DbOrTx, kind: JobKind, payload: Record<string, unknown>, runAt: Date, now: Date = new Date()): number {
  return tx
    .insert(jobs)
    .values({ kind, payload, runAt: runAt.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() })
    .returning({ id: jobs.id })
    .get().id;
}

/**
 * Runs every pending job whose time has come, oldest first, one at a time. Overdue jobs
 * (e.g. the PC was off) simply run at the next tick after start.
 */
export async function runDueJobs(db: Db, handlers: JobHandlers, now: () => Date = () => new Date()): Promise<number> {
  let ran = 0;
  for (;;) {
    const at = now();
    const job = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "PENDING"), lte(jobs.runAt, at.toISOString())))
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .get();
    if (!job) return ran;
    db.update(jobs).set({ status: "RUNNING", attempts: job.attempts + 1, updatedAt: at.toISOString() }).where(eq(jobs.id, job.id)).run();

    let outcome: JobOutcome;
    try {
      outcome = await handlers[job.kind]({ ...job, attempts: job.attempts + 1 }, at);
    } catch (error) {
      // A handler bug must not stop the queue; the job is parked as failed and logged.
      logger.error({ err: error, jobId: job.id, kind: job.kind }, "job handler crashed");
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    const done = now().toISOString();
    if (outcome.status === "done") {
      db.update(jobs).set({ status: "DONE", lastError: null, updatedAt: done }).where(eq(jobs.id, job.id)).run();
    } else if (outcome.status === "retry") {
      db.update(jobs).set({ status: "PENDING", runAt: outcome.at.toISOString(), lastError: outcome.error, updatedAt: done }).where(eq(jobs.id, job.id)).run();
    } else {
      db.update(jobs).set({ status: "FAILED", lastError: outcome.error, updatedAt: done }).where(eq(jobs.id, job.id)).run();
    }
    ran++;
  }
}

/** After a crash or restart, a job left RUNNING is run again; handlers must tolerate that. */
export function recoverInterruptedJobs(db: Db, now: Date = new Date()): number {
  return db.update(jobs).set({ status: "PENDING", updatedAt: now.toISOString() }).where(eq(jobs.status, "RUNNING")).run().changes;
}

const TICK_MS = 10_000;
const globalForScheduler = globalThis as unknown as { schedulerTimer?: NodeJS.Timeout };

/** The in-process scheduler: one tick at a time, every few seconds, for the life of the server. */
export function startScheduler(db: Db, handlers: JobHandlers): void {
  if (globalForScheduler.schedulerTimer) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueJobs(db, handlers);
    } catch (error) {
      logger.error({ err: error }, "scheduler tick failed");
    } finally {
      busy = false;
    }
  };
  globalForScheduler.schedulerTimer = setInterval(tick, TICK_MS);
  void tick();
}
