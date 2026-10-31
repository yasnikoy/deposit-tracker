import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { emailBlLinks, emails, jobs, notes } from "@/server/db/schema";
import type { MailTransport } from "@/server/email/transport";
import { DomainError, ForbiddenError } from "@/server/errors";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { addNotes, blNotes } from "@/server/notes";
import { listNotifications, markNotificationsRead, notifyOverdueReplies, unreadNotificationCount } from "@/server/notifications";
import { correctPayment } from "@/server/payments";
import { ensureRecurringJobs, recurringJobHandlers, scheduleWeeklySummary, weeklySummaryValues } from "@/server/recurring-jobs";
import { updateSettings } from "@/server/settings";
import { undoActions } from "@/server/undo";
import { users } from "@/server/db/schema";
import { approveWriteOff, proposeWriteOff, rejectWriteOff } from "@/server/write-offs";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const at = (iso: string) => new Date(iso);

let db: Db;
let admin: AuthUser;
let admin2: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let ops2: AuthUser;
let ops3: AuthUser;
let agency: number;
let a: { paymentId: number; blId: number };
let b: { paymentId: number; blId: number };

const kinds = (user: AuthUser) => listNotifications(db, user).map((n) => n.kind);

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  admin2 = await makeUser(db, "admin2", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  ops2 = await makeUser(db, "ayse", ["OPERATIONS"]);
  ops3 = await makeUser(db, "mehmet", ["OPERATIONS"]);
  agency = makeAgency(db, ops, "Hapag", { toRecipients: ["iade@hapag.example"] });
  a = makeBl(db, { acc, ops }, { agencyId: agency, blNo: "HLCU1000001", amountMinor: 300000, paidAt: "2026-07-01" }, NOW);
  b = makeBl(db, { acc, ops }, { agencyId: agency, blNo: "HLCU1000002", amountMinor: 150000, paidAt: "2026-10-01", currency: "EUR" }, NOW);
});

describe("notes", () => {
  it("adds a note with @mentions; mentioned users are notified, the author is not", () => {
    const [auditId] = addNotes(db, ops, { blIds: [a.blId], body: "@Ayse acenteyi aradım, @ops ve @ayse yarın tekrar." }, NOW);
    expect(auditId).toBeGreaterThan(0);
    expect(blNotes(db, a.blId)).toMatchObject([{ body: "@Ayse acenteyi aradım, @ops ve @ayse yarın tekrar.", authorName: "OPS", undone: false }]);
    expect(listNotifications(db, ops2)).toMatchObject([
      { kind: "MENTION", entityType: "bill_of_lading", entityId: a.blId, read: false, detail: { author: "OPS", blNo: "HLCU1000001" } },
    ]);
    expect(kinds(ops)).toEqual([]);
    expect(kinds(ops3)).toEqual([]);
    // The note shows on the B/L timeline.
    expect(getBlDetail(db, ops, a.blId, NOW).timeline[0]).toMatchObject({ action: "note.add", actorName: "OPS", undoable: true });
  });

  it("refuses unknown or inactive users, empty notes and other roles", () => {
    expect(() => addNotes(db, ops, { blIds: [a.blId], body: "@kimse bakar mı?" }, NOW)).toThrow(DomainError);
    db.update(users).set({ active: false }).where(eq(users.id, ops3.id)).run();
    expect(() => addNotes(db, ops, { blIds: [a.blId], body: "@mehmet" }, NOW)).toThrow(/unknownMention/);
    expect(() => addNotes(db, ops, { blIds: [a.blId], body: "   " }, NOW)).toThrow(/empty/);
    expect(() => addNotes(db, acc, { blIds: [a.blId], body: "Not" }, NOW)).toThrow(ForbiddenError);
    expect(db.select().from(notes).all()).toHaveLength(0);
  });

  it("adds one note to several B/Ls as one action, which undo takes back together", () => {
    const auditIds = addNotes(db, ops, { blIds: [a.blId, b.blId], body: "Toplu takip @ayse" }, NOW);
    expect(auditIds).toHaveLength(2);
    expect(kinds(ops2)).toEqual(["MENTION", "MENTION"]);
    undoActions(db, ops, { auditIds }, at("2026-10-22T09:05:00Z"));
    expect([...blNotes(db, a.blId), ...blNotes(db, b.blId)].map((n) => n.undone)).toEqual([true, true]);
    expect(() => undoActions(db, ops, { auditIds }, at("2026-10-22T09:06:00Z"))).toThrow(DomainError);
  });
});

describe("notifications", () => {
  it("a payment correction notifies the operations users who worked on the B/L", () => {
    addNotes(db, ops2, { blIds: [a.blId], body: "Takipteyim" }, NOW);
    correctPayment(db, acc, { id: a.paymentId, agencyId: agency, amountMinor: 310000, currency: "USD", paidAt: "2026-07-01", reason: "Tutar hatalı" }, NOW);
    // ops created the B/L, ayse wrote a note; mehmet never touched it.
    expect(kinds(ops)).toEqual(["CORRECTION"]);
    expect(kinds(ops2)).toEqual(["CORRECTION"]);
    expect(kinds(ops3)).toEqual([]);
    expect(listNotifications(db, ops)[0].detail).toMatchObject({ actor: "ACC", blNo: "HLCU1000001", beforeMinor: 300000, afterMinor: 310000, afterCurrency: "USD", reason: "Tutar hatalı" });
  });

  it("write-offs: a proposal notifies every admin; the decision notifies the proposer", () => {
    const first = proposeWriteOff(db, ops2, { blId: a.blId, reason: "Takibe değmez" }, NOW);
    expect(kinds(admin)).toEqual(["WRITE_OFF_PROPOSED"]);
    expect(kinds(admin2)).toEqual(["WRITE_OFF_PROPOSED"]);
    rejectWriteOff(db, admin, { writeOffId: first, reason: "Tekrar deneyin" }, NOW);
    expect(listNotifications(db, ops2)).toMatchObject([{ kind: "WRITE_OFF_DECIDED", detail: { decision: "REJECTED", note: "Tekrar deneyin" } }]);
    approveWriteOff(db, admin, { writeOffId: proposeWriteOff(db, ops2, { blId: a.blId, reason: "Acente kapandı" }, NOW), note: null }, NOW);
    expect(listNotifications(db, ops2)[0]).toMatchObject({ kind: "WRITE_OFF_DECIDED", detail: { decision: "APPROVED", amountMinor: 300000 } });
  });

  it("a kind switched off in settings notifies nobody", () => {
    updateSettings(db, admin, { changes: [{ key: "notifications.inAppMention", value: false }] }, NOW);
    addNotes(db, ops, { blIds: [a.blId], body: "@ayse" }, NOW);
    expect(kinds(ops2)).toEqual([]);
  });

  it("an overdue reply notifies every operations user once", () => {
    const email = db
      .insert(emails)
      .values({ direction: "IN", agencyId: agency, messageId: "<r1@hapag.example>", fromAddress: "iade@hapag.example", to: ["depozito@firma.example"], subject: "RE: İade", bodyText: "?", receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() })
      .returning()
      .get();
    db.insert(emailBlLinks).values({ emailId: email.id, blId: a.blId, linkedBy: "THREAD", createdAt: NOW.toISOString() }).run();
    notifyOverdueReplies(db, NOW);
    expect(kinds(ops)).toEqual([]);
    // One business day later it is past the warning.
    notifyOverdueReplies(db, at("2026-10-23T09:00:00Z"));
    notifyOverdueReplies(db, at("2026-10-23T10:00:00Z"));
    for (const user of [ops, ops2, ops3]) expect(kinds(user)).toEqual(["UNPROCESSED_REPLY"]);
    expect(listNotifications(db, ops)[0]).toMatchObject({ entityType: "email", entityId: email.id, detail: { agency: "Hapag", subject: "RE: İade" } });
    expect(kinds(admin)).toEqual([]);
  });

  it("each user reads and marks only their own", () => {
    addNotes(db, ops, { blIds: [a.blId, b.blId], body: "@ayse @mehmet" }, NOW);
    const [latest] = listNotifications(db, ops2);
    markNotificationsRead(db, ops2, { ids: [latest.id] }, NOW);
    expect(unreadNotificationCount(db, ops2)).toBe(1);
    // Someone else's ids are ignored.
    markNotificationsRead(db, ops2, { ids: listNotifications(db, ops3).map((n) => n.id) }, NOW);
    expect(unreadNotificationCount(db, ops3)).toBe(2);
    markNotificationsRead(db, ops3, {}, NOW);
    expect(unreadNotificationCount(db, ops3)).toBe(0);
  });
});

describe("weekly summary email", () => {
  const sent: { to: string[]; text: string }[] = [];
  const mail: MailTransport = {
    dryRun: false,
    async send(raw, envelope) {
      sent.push({ to: envelope.to, text: raw.toString("utf8") });
    },
    async appendToSent() {},
  };

  it("is scheduled for its weekday and time, sends open balances, long waits and replies, then the next week", async () => {
    sent.length = 0;
    ensureRecurringJobs(db, NOW);
    const weekly = () => db.select().from(jobs).all().filter((j) => j.kind === "WEEKLY_SUMMARY_EMAIL" && j.status === "PENDING");
    // Monday 26 Oct, 09:00 Istanbul.
    expect(weekly()).toMatchObject([{ payload: { date: "2026-10-26" }, runAt: "2026-10-26T06:00:00.000Z" }]);

    // A changed weekday and time move the pending job.
    updateSettings(db, admin, { changes: [{ key: "notifications.weeklySummaryWeekday", value: 5 }, { key: "notifications.weeklySummaryTime", value: "16:30" }] }, NOW);
    scheduleWeeklySummary(db, NOW, { move: true });
    expect(weekly()).toMatchObject([{ payload: { date: "2026-10-23" }, runAt: "2026-10-23T13:30:00.000Z" }]);

    updateSettings(
      db,
      admin,
      {
        changes: [
          { key: "notifications.weeklySummaryEmail", value: true },
          { key: "notifications.weeklySummaryRecipients", value: ["ekip@firma.example"] },
          { key: "email.fromAddress", value: "depozito@firma.example" },
        ],
      },
      NOW,
    );
    const handlers = recurringJobHandlers(db, { mailbox: () => null, transport: () => mail, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "deposit-test-")) }) as JobHandlers;
    await runDueJobs(db, handlers, () => at("2026-10-23T13:30:00Z"));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["ekip@firma.example"]);
    expect(weekly()).toMatchObject([{ payload: { date: "2026-10-30" } }]);

    const values = weeklySummaryValues(db, at("2026-10-23T13:30:00Z"));
    expect(values).toMatchObject({ date: "23.10.2026", balance_lines: "• 1.500,00 EUR (1 B/L)\n• 3.000,00 USD (1 B/L)", waiting_days: "60", waiting_count: "1", unprocessed_count: "0" });
    // Paid 1 July: past the last aging edge.
    expect(values.waiting_lines).toMatch(/^• HLCU1000001 · Hapag · \d+ iş günü · 3\.000,00 USD$/);
  });
});
