import { eq } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { billsOfLading, emails, replyTypes } from "@/server/db/schema";
import { archiveEmail } from "@/server/email/archive";
import { prepareRequestEmails, type EmailDraft } from "@/server/email/compose";
import { emailJobHandlers, queueRequestEmail } from "@/server/email/send";
import type { Envelope, MailTransport } from "@/server/email/transport";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { listReplyTypes, saveReplyType } from "@/server/lists";
import { recordReplyWithoutEmail } from "@/server/replies";
import { blDueState } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { PDF, makeAgency, makeBl, giveStandingDocuments } from "../support/records";

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
  giveStandingDocuments(db, ops);
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

describe("recording replies", () => {
  /** The agency's answer, archived from Outlook on the B/L (a reply in the request's thread). */
  async function archivedReply(blId: number, inReplyTo: string, text = "Konteyner dönmedi") {
    const messageId = "<agency-1@maersk.example>";
    const raw = await new MailComposer({ from: "refund@maersk.example", to: "depozito@firma.com.tr", subject: "RE: talep", text, messageId, inReplyTo, references: [inReplyTo], date: at("2026-10-22T10:00:00Z") })
      .compile()
      .build();
    await archiveEmail(db, ops, { blId, fileName: "RE talep.eml", content: raw }, NOW);
    return messageId;
  }

  it("'not yet returned' moves each B/L to awaiting return and restarts the follow-up clock; the follow-up replies to the archived answer", async () => {
    const a = newBl(maersk, "MAEU1000001");
    const b = newBl(maersk, "MAEU1000002");
    const sent = await sendRequests([a, b]);
    const agencyMessageId = await archivedReply(a, sent[0].messageId);

    expect(() => recordReplyWithoutEmail(db, acc, { blId: a, replyTypeId: typeId("NOT_RETURNED"), repliedOn: "2026-10-22", note: null }, NOW)).toThrow(ForbiddenError);
    for (const blId of [a, b]) recordReplyWithoutEmail(db, ops, { blId, replyTypeId: typeId("NOT_RETURNED"), repliedOn: "2026-10-22", note: null }, NOW);
    expect([status(a), status(b)]).toEqual(["AWAITING_RETURN", "AWAITING_RETURN"]);

    // Follow-up due 5 business days after the reply (Thu 22 Oct → Thu 29 Oct), replying to the agency's email.
    expect(blDueState(db, a, NOW)).toMatchObject({ kind: "FOLLOW_UP", dueDate: "2026-10-29" });
    const followUpDay = at("2026-10-29T09:00:00Z");
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a, b] }, followUpDay);
    expect(draft.thread?.messageId).toBe(agencyMessageId);
    expect(draft.subject).toBe("RE: talep");
    expect(draft.body).toContain("Kimden: refund@maersk.example");
    expect(draft.body).toContain("Konteyner dönmedi");
    expect(getBlDetail(db, ops, a, NOW).timeline.map((e) => e.action)).toEqual(expect.arrayContaining(["email.link", "reply.record"]));
  });

  it("an info-only reply does not restart the follow-up clock", async () => {
    const a = newBl(msc, "MEDU1000001");
    await sendRequests([a]);
    const due = blDueState(db, a, NOW)!;
    recordReplyWithoutEmail(db, ops, { blId: a, replyTypeId: typeId("INFO"), repliedOn: "2026-10-22", note: "Out of office" }, NOW);
    expect(status(a)).toBe("REQUESTED");
    expect(blDueState(db, a, NOW)!.dueDate).toBe(due.dueDate);
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
});
