import "server-only";
import os from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { addCalendarDays, istanbulInstant, istanbulToday, type IsoDate } from "@/domain/business-days";
import { renderTemplate } from "@/domain/email-templates";
import type { JobKind } from "@/domain/records";
import type { Db, DbOrTx } from "./db/client";
import { jobs } from "./db/schema";
import { imapPollHandler } from "./email/inbound";
import type { Mailbox } from "./email/mailbox";
import { getEmailTemplate } from "./email/templates";
import type { MailTransport } from "./email/transport";
import { enqueueJob, type JobHandler, type JobHandlers } from "./jobs";
import { logger } from "./logger";
import { unprocessedSummary } from "./replies";
import { markServiceFailing, markServiceOk } from "./service-status";
import { getSetting } from "./settings";

const pending = (db: DbOrTx, kind: JobKind) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), inArray(jobs.status, ["PENDING", "RUNNING"])))
    .all();

/** The daily email of one date runs at the configured Istanbul time of that date. */
const dailyRunAt = (db: DbOrTx, date: IsoDate) => istanbulInstant(date, getSetting("notifications.dailyUnprocessedTime", {}, db));

/**
 * Keeps one pending daily-email job, for today if its time is still ahead and it has not run
 * today, otherwise for tomorrow. After the time setting changes, the pending job moves to the
 * new time of its date.
 */
export function scheduleDailyEmail(db: DbOrTx, now: Date = new Date()): void {
  const waiting = pending(db, "DAILY_UNPROCESSED_EMAIL").filter((job) => job.status === "PENDING");
  if (waiting.length > 0) {
    for (const job of waiting) {
      const runAt = dailyRunAt(db, String(job.payload.date)).toISOString();
      if (runAt !== job.runAt) db.update(jobs).set({ runAt, updatedAt: now.toISOString() }).where(eq(jobs.id, job.id)).run();
    }
    return;
  }
  if (pending(db, "DAILY_UNPROCESSED_EMAIL").length > 0) return;
  const today = istanbulToday(now);
  const ranToday = db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, "DAILY_UNPROCESSED_EMAIL"), eq(jobs.status, "DONE")))
    .all()
    .some((job) => job.payload.date === today);
  const date = !ranToday && now < dailyRunAt(db, today) ? today : addCalendarDays(today, 1);
  enqueueJob(db, "DAILY_UNPROCESSED_EMAIL", { date }, dailyRunAt(db, date), now);
}

/** At start: one pending mailbox poll (overdue ones simply run now) and one daily-email job. */
export function ensureRecurringJobs(db: Db, now: Date = new Date()): void {
  db.transaction((tx) => {
    if (pending(tx, "IMAP_POLL").length === 0) enqueueJob(tx, "IMAP_POLL", {}, now, now);
    scheduleDailyEmail(tx, now);
  });
}

/** Runs a recurring job and always queues its next run, whatever the outcome. */
function recurring(db: Db, handler: JobHandler, next: (tx: DbOrTx, job: Parameters<JobHandler>[0], now: Date) => void): JobHandler {
  return async (job, now) => {
    try {
      return await handler(job, now);
    } finally {
      db.transaction((tx) => next(tx, job, now));
    }
  };
}

/** The next daily run after one for `date`: never in the past, so days the PC was off are not repeated. */
function nextDailyDate(db: DbOrTx, date: IsoDate, now: Date): IsoDate {
  const today = istanbulToday(now);
  const next = addCalendarDays(date, 1) > today ? addCalendarDays(date, 1) : today;
  return dailyRunAt(db, next) > now ? next : addCalendarDays(next, 1);
}

/** Where the team opens the Replies screen: the host PC on the office network. */
function repliesLink(): string {
  return `http://${os.hostname()}:${process.env.PORT ?? "3000"}/replies`;
}

/**
 * The optional internal reminder: unprocessed replies past the warning, per agency. Sent only
 * when switched on, with recipients, and when there is at least one; honours dry-run.
 */
function dailyEmailHandler(db: Db, transport: () => MailTransport): JobHandler {
  return async (_job, now) => {
    if (!getSetting("notifications.dailyUnprocessedEmail", {}, db)) return { status: "done" };
    const recipients = getSetting("notifications.dailyUnprocessedRecipients", {}, db);
    const fromAddress = getSetting("email.fromAddress", {}, db);
    const summary = unprocessedSummary(db, now);
    if (recipients.length === 0 || !fromAddress || summary.overdue === 0) return { status: "done" };

    const template = getEmailTemplate(db, "DAILY_UNPROCESSED");
    const values = {
      count: String(summary.overdue),
      warning_days: String(getSetting("durations.unprocessedReplyWarningDays", {}, db)),
      agency_lines: summary.overdueByAgency.map((a) => `• ${a.agencyName}: ${a.count}`).join("\n"),
      link: repliesLink(),
    };
    const fromName = getSetting("email.fromName", {}, db);
    const raw = await new MailComposer({
      from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
      to: recipients,
      subject: renderTemplate(template.subject, values),
      text: renderTemplate(template.body, values),
      date: now,
    })
      .compile()
      .build();
    const mail = transport();
    try {
      await mail.send(raw, { from: fromAddress, to: recipients });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      markServiceFailing(db, "SMTP", message, now);
      return { status: "failed", error: message };
    }
    if (!mail.dryRun) markServiceOk(db, "SMTP", now);
    logger.info({ overdue: summary.overdue, dryRun: mail.dryRun }, "daily unprocessed-reply email sent");
    return { status: "done" };
  };
}

export function recurringJobHandlers(
  db: Db,
  deps: { mailbox: () => Mailbox | null; transport: () => MailTransport },
): Pick<JobHandlers, "IMAP_POLL" | "DAILY_UNPROCESSED_EMAIL"> {
  return {
    IMAP_POLL: recurring(db, imapPollHandler(db, deps.mailbox), (tx, _job, now) => {
      const minutes = getSetting("email.pollIntervalMinutes", {}, tx);
      enqueueJob(tx, "IMAP_POLL", {}, new Date(now.getTime() + minutes * 60_000), now);
    }),
    DAILY_UNPROCESSED_EMAIL: recurring(db, dailyEmailHandler(db, deps.transport), (tx, job, now) => {
      const date = nextDailyDate(tx, String(job.payload.date), now);
      enqueueJob(tx, "DAILY_UNPROCESSED_EMAIL", { date }, dailyRunAt(tx, date), now);
    }),
  };
}
