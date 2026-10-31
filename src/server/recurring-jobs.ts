import "server-only";
import os from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { addCalendarDays, istanbulInstant, istanbulToday, onOrAfterWeekday, type IsoDate } from "@/domain/business-days";
import { renderTemplate } from "@/domain/email-templates";
import type { JobKind } from "@/domain/records";
import type { Db, DbOrTx } from "./db/client";
import { jobs } from "./db/schema";
import { imapPollHandler } from "./email/inbound";
import type { Mailbox } from "./email/mailbox";
import { getEmailTemplate } from "./email/templates";
import type { MailTransport } from "./email/transport";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { enqueueJob, type JobHandler, type JobHandlers } from "./jobs";
import { logger } from "./logger";
import { notifyOverdueReplies } from "./notifications";
import { unprocessedSummary } from "./replies";
import { positionsForJob, totalsByCurrency } from "./reports";
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

const weeklyRunAt = (db: DbOrTx, date: IsoDate) => istanbulInstant(date, getSetting("notifications.weeklySummaryTime", {}, db));
const weeklyRanOn = (db: DbOrTx, date: IsoDate) =>
  db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, "WEEKLY_SUMMARY_EMAIL"), eq(jobs.status, "DONE")))
    .all()
    .some((job) => job.payload.date === date);

/** The next weekly date from today: today only if it is the weekday, its time is ahead and it has not run. */
function firstWeeklyDate(db: DbOrTx, now: Date): IsoDate {
  const today = istanbulToday(now);
  const weekday = getSetting("notifications.weeklySummaryWeekday", {}, db);
  const date = onOrAfterWeekday(today, weekday);
  if (date === today && (weeklyRanOn(db, today) || now >= weeklyRunAt(db, today))) return onOrAfterWeekday(addCalendarDays(today, 1), weekday);
  return date;
}

/**
 * Keeps one pending weekly-summary job. At start a missed one keeps its date and runs now;
 * after its weekday or time setting changes (`move`), the pending job moves to the new schedule.
 */
export function scheduleWeeklySummary(db: DbOrTx, now: Date = new Date(), options: { move?: boolean } = {}): void {
  const jobsInFlight = pending(db, "WEEKLY_SUMMARY_EMAIL");
  const waiting = jobsInFlight.filter((job) => job.status === "PENDING");
  if (waiting.length > 0) {
    if (!options.move) return;
    const date = firstWeeklyDate(db, now);
    for (const job of waiting) {
      db.update(jobs).set({ payload: { date }, runAt: weeklyRunAt(db, date).toISOString(), updatedAt: now.toISOString() }).where(eq(jobs.id, job.id)).run();
    }
    return;
  }
  if (jobsInFlight.length > 0) return;
  const date = firstWeeklyDate(db, now);
  enqueueJob(db, "WEEKLY_SUMMARY_EMAIL", { date }, weeklyRunAt(db, date), now);
}

/** The weekly run after one for `date`: never in the past, so weeks the PC was off are not repeated. */
function nextWeeklyDate(db: DbOrTx, date: IsoDate, now: Date): IsoDate {
  const weekday = getSetting("notifications.weeklySummaryWeekday", {}, db);
  const today = istanbulToday(now);
  const from = addCalendarDays(date, 1) > today ? addCalendarDays(date, 1) : today;
  const next = onOrAfterWeekday(from, weekday);
  return weeklyRunAt(db, next) > now ? next : onOrAfterWeekday(addCalendarDays(next, 1), weekday);
}

/** At start: one pending mailbox poll (overdue ones simply run now), one daily-email and one weekly-summary job. */
export function ensureRecurringJobs(db: Db, now: Date = new Date()): void {
  db.transaction((tx) => {
    if (pending(tx, "IMAP_POLL").length === 0) enqueueJob(tx, "IMAP_POLL", {}, now, now);
    scheduleDailyEmail(tx, now);
    scheduleWeeklySummary(tx, now);
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

/** Where the team opens the app: the host PC on the office network. */
function appLink(path: string): string {
  return `http://${os.hostname()}:${process.env.PORT ?? "3000"}${path}`;
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
      link: appLink("/replies"),
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

/** The weekly summary values: open balance per currency, B/Ls waiting longest, unprocessed replies. */
export function weeklySummaryValues(db: DbOrTx, now: Date): Record<string, string> {
  const open = positionsForJob(db, now).filter((p) => p.open && p.outstandingMinor > 0);
  const edges = getSetting("durations.agingBucketEdges", {}, db);
  const longest = edges[edges.length - 1];
  const waiting = open.filter((p) => (p.daysWaiting ?? 0) > longest).sort((a, b) => (b.daysWaiting ?? 0) - (a.daysWaiting ?? 0));
  const balances = totalsByCurrency(open.map((p) => ({ currency: p.currency, amountMinor: p.outstandingMinor })));
  const unprocessed = unprocessedSummary(db, now);
  return {
    date: formatBusinessDate(istanbulToday(now)),
    balance_lines: balances.length > 0 ? balances.map((b) => `• ${formatAmount(b.amountMinor)} ${b.currency} (${open.filter((p) => p.currency === b.currency).length} B/L)`).join("\n") : "• —",
    waiting_days: String(longest),
    waiting_count: String(waiting.length),
    waiting_lines: waiting.map((p) => `• ${p.blNo} · ${p.agencyName} · ${t("reports.email.waitingDays", { days: p.daysWaiting ?? 0 })} · ${formatAmount(p.outstandingMinor)} ${p.currency}`).join("\n"),
    unprocessed_count: String(unprocessed.count),
    overdue_count: String(unprocessed.overdue),
    link: appLink("/"),
  };
}

/** The optional weekly email to the team; sent only when switched on and with recipients; honours dry-run. */
function weeklySummaryHandler(db: Db, transport: () => MailTransport): JobHandler {
  return async (_job, now) => {
    if (!getSetting("notifications.weeklySummaryEmail", {}, db)) return { status: "done" };
    const recipients = getSetting("notifications.weeklySummaryRecipients", {}, db);
    const fromAddress = getSetting("email.fromAddress", {}, db);
    if (recipients.length === 0 || !fromAddress) return { status: "done" };
    const template = getEmailTemplate(db, "WEEKLY_SUMMARY");
    const values = weeklySummaryValues(db, now);
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
    logger.info({ dryRun: mail.dryRun }, "weekly summary email sent");
    return { status: "done" };
  };
}

export function recurringJobHandlers(
  db: Db,
  deps: { mailbox: () => Mailbox | null; transport: () => MailTransport },
): Pick<JobHandlers, "IMAP_POLL" | "DAILY_UNPROCESSED_EMAIL" | "WEEKLY_SUMMARY_EMAIL"> {
  return {
    IMAP_POLL: recurring(db, imapPollHandler(db, deps.mailbox), (tx, _job, now) => {
      notifyOverdueReplies(tx, now);
      const minutes = getSetting("email.pollIntervalMinutes", {}, tx);
      enqueueJob(tx, "IMAP_POLL", {}, new Date(now.getTime() + minutes * 60_000), now);
    }),
    WEEKLY_SUMMARY_EMAIL: recurring(db, weeklySummaryHandler(db, deps.transport), (tx, job, now) => {
      const date = nextWeeklyDate(tx, String(job.payload.date), now);
      enqueueJob(tx, "WEEKLY_SUMMARY_EMAIL", { date }, weeklyRunAt(tx, date), now);
    }),
    DAILY_UNPROCESSED_EMAIL: recurring(db, dailyEmailHandler(db, deps.transport), (tx, job, now) => {
      const date = nextDailyDate(tx, String(job.payload.date), now);
      enqueueJob(tx, "DAILY_UNPROCESSED_EMAIL", { date }, dailyRunAt(tx, date), now);
    }),
  };
}
