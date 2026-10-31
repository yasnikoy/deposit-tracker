import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { billsOfLading, documents, emails, jobs, mailboxState, replyTypes } from "@/server/db/schema";
import { prepareRequestEmails, type EmailDraft } from "@/server/email/compose";
import { pollMailbox } from "@/server/email/inbound";
import type { Mailbox, MailboxMessage } from "@/server/email/mailbox";
import { emailJobHandlers, queueRequestEmail } from "@/server/email/send";
import type { Envelope, MailTransport } from "@/server/email/transport";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { listReplyTypes, saveReplyType } from "@/server/lists";
import { ensureRecurringJobs, recurringJobHandlers } from "@/server/recurring-jobs";
import {
  acceptSuggestion,
  dismissSuggestion,
  getReplyDetail,
  linkMailboxMessage,
  listReplies,
  recordEmailReplies,
  recordReplyWithoutEmail,
  searchMailboxForBl,
  unprocessedSummary,
} from "@/server/replies";
import { blDueState, recordPortalRequest } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const at = (iso: string) => new Date(iso);

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let maersk: number;
let msc: number;

const transport = (): MailTransport & { sent: Envelope[] } => {
  const sent: Envelope[] = [];
  return { dryRun: false, sent, async send(_raw, envelope) { sent.push(envelope); }, async appendToSent() {} };
};

/** An in-memory mailbox folder; it records nothing but reads, like the real one. */
function fakeMailbox(uidValidity = "7") {
  const messages: (MailboxMessage & { from: string; subject: string; messageId: string })[] = [];
  let nextUid = 1;
  const mailbox: Mailbox = {
    folder: "INBOX",
    async readNew(cursor, since, limit) {
      const valid = cursor?.uidValidity === uidValidity ? cursor : null;
      const all = messages.filter((m) => (valid ? m.uid > valid.lastUid : m.receivedAt >= since));
      const batch = all.slice(0, limit);
      const lastUid = batch.length < all.length ? batch[batch.length - 1].uid : Math.max(nextUid - 1, valid?.lastUid ?? 0);
      return { cursor: { uidValidity, lastUid }, messages: batch };
    },
    async search(query, limit) {
      const results = messages
        .filter((m) => m.from.includes(query.from) && m.subject.includes(query.subject))
        .reverse()
        .slice(0, limit)
        .map((m) => ({ uid: m.uid, messageId: m.messageId, from: m.from, subject: m.subject, receivedAt: m.receivedAt.toISOString() }));
      return { uidValidity, results };
    },
    async fetch(uid, validity) {
      return validity === uidValidity ? (messages.find((m) => m.uid === uid) ?? null) : null;
    },
  };
  const deliver = async (input: {
    from: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    receivedAt?: Date;
    attachments?: { filename: string; content: Buffer }[];
    messageId?: string;
  }) => {
    const messageId = input.messageId ?? `<agency-${nextUid}@agency.example>`;
    const raw = await new MailComposer({
      from: input.from,
      to: "depozito@firma.com.tr",
      subject: input.subject,
      text: input.text,
      messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: input.attachments,
    })
      .compile()
      .build();
    messages.push({ uid: nextUid++, raw, receivedAt: input.receivedAt ?? NOW, from: input.from, subject: input.subject, messageId });
    return messageId;
  };
  return { mailbox, deliver };
}

const handlers = (mail: MailTransport) => emailJobHandlers(db, () => mail) as JobHandlers;

function attachForm(blId: number) {
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
}

/** Sends the refund request emails of the given B/Ls; returns the stored drafts' message ids. */
async function sendRequests(blIds: number[], when = NOW): Promise<{ draft: EmailDraft; messageId: string }[]> {
  const drafts = prepareRequestEmails(db, ops, { blIds }, when);
  const result = [];
  for (const draft of drafts) {
    const id = queueRequestEmail(
      db,
      ops,
      {
        blIds: draft.items.map((i) => i.blId),
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        documentIds: draft.attachments.map((a) => a.documentId),
      },
      when,
    );
    result.push({ draft, messageId: db.select().from(emails).where(eq(emails.id, id)).get()!.messageId });
  }
  await runDueJobs(db, handlers(transport()), () => when);
  return result;
}

const typeId = (code: string) => db.select().from(replyTypes).all().find((t) => t.code === code)!.id;
const status = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.status;
const newBl = (agencyId: number, blNo: string) => {
  const id = makeBl(db, { acc, ops }, { agencyId, blNo, paidAt: "2026-10-01", amountMinor: 300000 }, NOW).blId;
  attachForm(id);
  return id;
};

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "depozito@firma.com.tr" }] }, NOW);
  maersk = makeAgency(db, ops, "Maersk", { toRecipients: ["refund@maersk.example"], batchSending: true });
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
});

describe("reply types", () => {
  it("are seeded with the four system types; admins add custom ones, system types stay active", () => {
    expect(listReplyTypes(db, ops).map((t) => t.code)).toEqual(["NOT_RETURNED", "APPROVED", "STATEMENT_RECEIVED", "INFO"]);
    expect(() => saveReplyType(db, ops, { name: "Diğer", active: true, sortOrder: 9, reason: null }, NOW)).toThrow(ForbiddenError);
    saveReplyType(db, admin, { name: "Diğer", active: true, sortOrder: 9, reason: null }, NOW);
    expect(() => saveReplyType(db, admin, { name: "diğer", active: true, sortOrder: 10, reason: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "lists.errors.typeTaken" }),
    );
    expect(() => saveReplyType(db, admin, { id: typeId("INFO"), name: "Bilgi", active: false, sortOrder: 3, reason: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "lists.errors.systemType" }),
    );
  });
});

describe("importing agency replies", () => {
  it("links a reply in a known thread to every B/L of the sent email and keeps its attachments", async () => {
    const a = newBl(maersk, "MAEU1000001");
    const b = newBl(maersk, "MAEU1000002");
    const [{ messageId }] = await sendRequests([a, b]);
    const { mailbox, deliver } = fakeMailbox();
    await deliver({
      from: "Refund Desk <refund@maersk.example>",
      subject: "RE: Depozito Talepleri",
      text: "Konteynerler henüz dönmedi.",
      inReplyTo: messageId,
      references: [messageId],
      receivedAt: at("2026-10-22T10:00:00Z"),
      attachments: [{ filename: "durum.pdf", content: PDF }],
    });
    await deliver({ from: "someone@else.example", subject: "Toplantı", text: "Yarın 10:00" });
    await deliver({ from: "depozito@firma.com.tr", subject: "MAEU1000001 iç not", text: "kendi adresimiz" });

    expect(await pollMailbox(db, mailbox, NOW)).toBe(1);
    const lists = listReplies(db, ops, NOW);
    expect(lists.TO_PROCESS).toHaveLength(1);
    expect(lists.TO_PROCESS[0]).toMatchObject({ from: "refund@maersk.example", agencyName: "Maersk", blNos: ["MAEU1000001", "MAEU1000002"], attachments: 1 });
    expect(lists.TO_PROCESS[0].pending.map((p) => p.blNo)).toEqual(["MAEU1000001", "MAEU1000002"]);
    const detail = getReplyDetail(db, ops, lists.TO_PROCESS[0].emailId);
    expect(detail.email.bodyText).toContain("Konteynerler henüz dönmedi.");
    expect(detail.attachments.map((x) => x.originalName)).toEqual(["durum.pdf"]);
    expect(detail.links.map((l) => l.linkedBy)).toEqual(["THREAD", "THREAD"]);
    // The raw message is kept as .eml, imported by the system (no uploader).
    const raw = db.select().from(documents).where(eq(documents.id, detail.email.rawDocumentId!)).get()!;
    expect(raw).toMatchObject({ mimeType: "message/rfc822", uploadedBy: null });

    // Polling again imports nothing twice; the cursor has moved on.
    expect(await pollMailbox(db, mailbox, NOW)).toBe(0);
    expect(db.select().from(mailboxState).get()).toMatchObject({ folder: "INBOX", uidValidity: "7", lastUid: 3 });
    expect(() => listReplies(db, acc, NOW)).toThrow(ForbiddenError);
  });

  it("suggests open B/Ls named in an unrelated message; a user accepts or dismisses each", async () => {
    const a = newBl(msc, "MEDU1000001");
    const b = newBl(msc, "MEDU1000002");
    await sendRequests([a, b]);
    const { mailbox, deliver } = fakeMailbox();
    await deliver({ from: "yeni@msc.example", subject: "İade hk. MEDU1000001 / MEDU1000002", text: "Ödeme planlandı." });
    await pollMailbox(db, mailbox, NOW);

    let lists = listReplies(db, ops, NOW);
    expect(lists.TO_PROCESS).toHaveLength(0);
    expect(lists.MATCHES[0].blNos.sort()).toEqual(["MEDU1000001", "MEDU1000002"]);
    const emailId = lists.MATCHES[0].emailId;
    expect(() => acceptSuggestion(db, acc, { emailId, blId: a }, NOW)).toThrow(ForbiddenError);
    acceptSuggestion(db, ops, { emailId, blId: a }, NOW);
    dismissSuggestion(db, ops, { emailId, blId: b }, NOW);
    expect(() => acceptSuggestion(db, ops, { emailId, blId: b }, NOW)).toThrow(expect.objectContaining({ messageKey: "replies.errors.suggestionGone" }));

    lists = listReplies(db, ops, NOW);
    expect(lists.MATCHES).toHaveLength(0);
    expect(lists.TO_PROCESS[0]).toMatchObject({ blNos: ["MEDU1000001"], agencyName: "MSC" });
    expect(getReplyDetail(db, ops, emailId).links[0].linkedBy).toBe("SUGGESTION");
  });
});

describe("recording reply types", () => {
  async function importedReply(blIds: number[], text = "Konteyner dönmedi", receivedAt = at("2026-10-22T10:00:00Z")) {
    const sent = await sendRequests(blIds);
    const { mailbox, deliver } = fakeMailbox();
    const agencyMessageId = await deliver({ from: "refund@maersk.example", subject: "RE: talep", text, inReplyTo: sent[0].messageId, receivedAt });
    await pollMailbox(db, mailbox, NOW);
    return { emailId: listReplies(db, ops, NOW).TO_PROCESS[0].emailId, agencyMessageId, mailbox, deliver };
  }

  it("'not yet returned' for all B/Ls of a batched reply moves them to awaiting return and restarts the follow-up clock", async () => {
    const a = newBl(maersk, "MAEU1000001");
    const b = newBl(maersk, "MAEU1000002");
    const { emailId, agencyMessageId } = await importedReply([a, b]);

    expect(() => recordEmailReplies(db, acc, { items: [{ emailId, blId: a }], replyTypeId: typeId("NOT_RETURNED") }, NOW)).toThrow(ForbiddenError);
    expect(recordEmailReplies(db, ops, { items: [{ emailId, blId: a }, { emailId, blId: b }], replyTypeId: typeId("NOT_RETURNED") }, NOW)).toHaveLength(2);
    expect([status(a), status(b)]).toEqual(["AWAITING_RETURN", "AWAITING_RETURN"]);
    expect(() => recordEmailReplies(db, ops, { items: [{ emailId, blId: a }], replyTypeId: typeId("INFO") }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "replies.errors.alreadyRecorded" }),
    );
    expect(listReplies(db, ops, NOW).PROCESSED).toHaveLength(1);
    expect(unprocessedSummary(db, NOW).count).toBe(0);

    // Follow-up due 5 business days after the reply (Thu 22 Oct → Thu 29 Oct), replying to the agency's email.
    expect(blDueState(db, a, NOW)).toMatchObject({ kind: "FOLLOW_UP", dueDate: "2026-10-29" });
    const followUpDay = at("2026-10-29T09:00:00Z");
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a, b] }, followUpDay);
    expect(draft.thread?.messageId).toBe(agencyMessageId);
    expect(draft.subject).toBe("RE: talep");
    expect(draft.body).toContain("Kimden: refund@maersk.example");
    expect(draft.body).toContain("Konteyner dönmedi");

    const timeline = getBlDetail(db, ops, a, NOW).timeline.map((e) => e.action);
    expect(timeline).toEqual(expect.arrayContaining(["email.received", "reply.record"]));
  });

  it("an info-only reply is processed but does not restart the follow-up clock", async () => {
    const a = newBl(msc, "MEDU1000001");
    const before = blDueState(db, a, NOW);
    const { emailId } = await importedReply([a], "Out of office", at("2026-10-23T10:00:00Z"));
    const due = blDueState(db, a, NOW)!;
    recordEmailReplies(db, ops, { items: [{ emailId, blId: a }], replyTypeId: typeId("INFO") }, NOW);
    expect(status(a)).toBe("REQUESTED");
    expect(blDueState(db, a, NOW)!.dueDate).toBe(due.dueDate);
    expect(before?.kind).toBe("FIRST");
  });

  it("a reply without an email counts like one; not before any request, not in the future", async () => {
    const a = newBl(msc, "MEDU1000001");
    expect(() => recordReplyWithoutEmail(db, ops, { blId: a, replyTypeId: typeId("NOT_RETURNED"), repliedOn: "2026-10-22", note: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "replies.errors.noRequest" }),
    );
    await sendRequests([a]);
    expect(() => recordReplyWithoutEmail(db, ops, { blId: a, replyTypeId: typeId("NOT_RETURNED"), repliedOn: "2026-10-23", note: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "replies.errors.futureDate" }),
    );
    recordReplyWithoutEmail(db, ops, { blId: a, replyTypeId: typeId("NOT_RETURNED"), repliedOn: "2026-10-22", note: "Portalda görüldü" }, NOW);
    expect(status(a)).toBe("AWAITING_RETURN");
    expect(blDueState(db, a, NOW)!.dueDate).toBe("2026-10-29");
  });

  it("is only possible for linked B/Ls", async () => {
    const a = newBl(maersk, "MAEU1000001");
    const other = newBl(msc, "MEDU1000009");
    const { emailId } = await importedReply([a]);
    expect(() => recordEmailReplies(db, ops, { items: [{ emailId, blId: other }], replyTypeId: typeId("APPROVED") }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "replies.errors.notLinked" }),
    );
  });
});

describe("manual link from the B/L detail", () => {
  it("finds a portal agency's email by sender and subject; its later replies join the thread", async () => {
    const portal = makeAgency(db, ops, "Portal Line", { requestChannel: "PORTAL", portalUrl: "https://p.example", toRecipients: ["ops@portal.example"] });
    const p = newBl(portal, "PRTL1000001");
    recordPortalRequest(db, ops, { blId: p, requestedOn: "2026-10-20", portalRef: "R-1" }, NOW);
    const { mailbox, deliver } = fakeMailbox();
    const first = await deliver({ from: "ops@portal.example", subject: "Başvurunuz alındı", text: "Referans R-1" });
    await pollMailbox(db, mailbox, NOW);
    expect(db.select().from(emails).all().filter((e) => e.direction === "IN")).toHaveLength(0);

    const found = await searchMailboxForBl(db, ops, mailbox, { blId: p, from: "portal.example", subject: "Başvuru" });
    expect(found.results.map((r) => r.subject)).toEqual(["Başvurunuz alındı"]);
    expect(await linkMailboxMessage(db, ops, mailbox, { blId: p, uid: found.results[0].uid, uidValidity: found.uidValidity }, NOW)).toHaveLength(1);
    const emailId = (await searchMailboxForBl(db, ops, mailbox, { blId: p, from: "", subject: "" })).results[0].emailId!;
    expect(getReplyDetail(db, ops, emailId).links[0]).toMatchObject({ blNo: "PRTL1000001", linkedBy: "MANUAL" });
    expect((await searchMailboxForBl(db, ops, mailbox, { blId: p, from: "", subject: "" })).results[0]).toMatchObject({ emailId, linked: true });
    await expect(searchMailboxForBl(db, acc, mailbox, { blId: p, from: "", subject: "" })).rejects.toThrow(ForbiddenError);
    await expect(searchMailboxForBl(db, ops, null, { blId: p, from: "", subject: "" })).rejects.toMatchObject({ messageKey: "replies.errors.noMailbox" });

    await deliver({ from: "ops@portal.example", subject: "RE: Başvurunuz alındı", text: "Konteyner dönmedi", inReplyTo: first, references: [first] });
    await pollMailbox(db, mailbox, NOW);
    expect(listReplies(db, ops, NOW).TO_PROCESS.map((r) => r.subject).sort()).toEqual(["Başvurunuz alındı", "RE: Başvurunuz alındı"]);
  });
});

describe("unprocessed replies and the daily email", () => {
  it("warns after the configured business days and emails the internal recipients when switched on", async () => {
    const a = newBl(maersk, "MAEU1000001");
    const [{ messageId }] = await sendRequests([a]);
    const { mailbox, deliver } = fakeMailbox();
    await deliver({ from: "refund@maersk.example", subject: "RE", text: "?", inReplyTo: messageId, receivedAt: at("2026-10-22T10:00:00Z") });
    await pollMailbox(db, mailbox, NOW);
    expect(unprocessedSummary(db, NOW)).toEqual({ count: 1, overdue: 0, overdueByAgency: [] });
    const nextDay = at("2026-10-23T09:00:00Z");
    expect(unprocessedSummary(db, nextDay)).toEqual({ count: 1, overdue: 1, overdueByAgency: [{ agencyName: "Maersk", count: 1 }] });

    const mail = transport();
    const recurring = recurringJobHandlers(db, { mailbox: () => mailbox, transport: () => mail, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "deposit-test-")) });
    const all = { ...handlers(mail), ...recurring } as JobHandlers;
    ensureRecurringJobs(db, nextDay);
    const daily = db.select().from(jobs).all().find((j) => j.kind === "DAILY_UNPROCESSED_EMAIL")!;
    // 12:00 Istanbul is past the 09:00 default: the first daily email is tomorrow's.
    expect(daily).toMatchObject({ payload: { date: "2026-10-24" }, runAt: "2026-10-24T06:00:00.000Z" });

    // Off by default: the job runs, sends nothing, and the next one is queued.
    await runDueJobs(db, all, () => at("2026-10-24T06:00:00Z"));
    expect(mail.sent).toHaveLength(0);
    updateSettings(
      db,
      admin,
      { changes: [{ key: "notifications.dailyUnprocessedEmail", value: true }, { key: "notifications.dailyUnprocessedRecipients", value: ["ekip@firma.com.tr"] }] },
      NOW,
    );
    await runDueJobs(db, all, () => at("2026-10-25T06:00:00Z"));
    expect(mail.sent).toEqual([{ from: "depozito@firma.com.tr", to: ["ekip@firma.com.tr"] }]);
    const pending = db.select().from(jobs).all().filter((j) => j.status === "PENDING");
    expect(pending.map((j) => [j.kind, j.payload.date ?? null]).sort()).toEqual([
      // The daily backup, still ahead at 12:30 that day.
      ["BACKUP", "2026-10-25"],
      ["DAILY_UNPROCESSED_EMAIL", "2026-10-26"],
      ["IMAP_POLL", null],
      // The weekly summary waits for its weekday (Monday by default).
      ["WEEKLY_SUMMARY_EMAIL", "2026-10-26"],
    ]);
  });
});
