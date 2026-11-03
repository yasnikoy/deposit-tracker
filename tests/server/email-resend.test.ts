import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail, listAllBls } from "@/server/bl-overview";
import { voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { emailBlLinks, emails, requests } from "@/server/db/schema";
import { prepareRequestEmails, type EmailDraft } from "@/server/email/compose";
import { importMessage } from "@/server/email/inbound";
import { prepareResend, queueResend } from "@/server/email/resend";
import { emailJobHandlers, queueRequestEmail } from "@/server/email/send";
import type { Envelope, MailTransport } from "@/server/email/transport";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

type Sent = { raw: string; envelope: Envelope };

/** Records what would go out; fails the first `failures` sends. */
function fakeTransport(options: { dryRun?: boolean; failures?: number } = {}) {
  const sent: Sent[] = [];
  const appended: string[] = [];
  let failures = options.failures ?? 0;
  const transport: MailTransport = {
    dryRun: options.dryRun ?? false,
    async send(raw, envelope) {
      if (failures-- > 0) throw new Error("connect ECONNREFUSED");
      sent.push({ raw: raw.toString("utf8"), envelope });
    },
    async appendToSent(raw) {
      appended.push(raw.toString("utf8"));
    },
  };
  return { transport, sent, appended };
}

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;

const bl = (agencyId: number, blNo: string, paidAt = "2026-10-01", containers: string[] = []) =>
  makeBl(db, { acc, ops }, { agencyId, blNo, paidAt, amountMinor: 300000, containers }, NOW).blId;
const attachForm = (blId: number, name = "imzali-form.pdf") =>
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: name, content: PDF, kind: "FORM" }, NOW).id }, NOW);
const send = (draft: EmailDraft, user = ops, overrides: Partial<Parameters<typeof queueRequestEmail>[2]> = {}) =>
  queueRequestEmail(
    db,
    user,
    {
      blIds: draft.items.map((i) => i.blId),
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      documentIds: draft.attachments.map((a) => a.documentId),
      ...overrides,
    },
    NOW,
  );
const handlers = (transport: MailTransport) => emailJobHandlers(db, () => transport) as JobHandlers;
const runJobs = (transport: MailTransport, at = NOW) => runDueJobs(db, handlers(transport), () => at);

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  updateSettings(
    db,
    admin,
    {
      changes: [
        { key: "email.fromAddress", value: "depozito@firma.com.tr" },
        { key: "email.fromName", value: "Firma Depozito" },
        { key: "email.signature", value: "Firma A.Ş. Operasyon" },
        { key: "email.defaultBcc", value: ["arsiv@firma.com.tr"] },
      ],
    },
    NOW,
  );
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"], ccRecipients: ["muhasebe@msc.example"] });
});


/** The agency's first request went to an address that turned out wrong. */
async function sentToWrongAddress() {
  const a = bl(msc, "MEDU1000001");
  attachForm(a);
  send(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0]);
  await runJobs(fakeTransport().transport);
  return { a, first: db.select().from(emails).get()! };
}
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

describe("resending a request email", () => {
  it("previews the original as sent; operations only", async () => {
    const { first } = await sentToWrongAddress();
    expect(() => prepareResend(db, acc, { emailId: first.id })).toThrow(ForbiddenError);
    const draft = prepareResend(db, ops, { emailId: first.id });
    expect(draft).toMatchObject({
      resendOfEmailId: first.id,
      agencyName: "MSC",
      to: first.to,
      cc: first.cc,
      subject: first.subject,
      body: first.bodyText,
      thread: null,
      items: [{ blNo: "MEDU1000001", attemptNo: 1, kind: "FIRST" }],
    });
    expect(draft.attachments.map((x) => x.originalName)).toEqual(["İade formu MEDU1000001.pdf", "Dekont MEDU1000001.pdf"]);
  });

  it("sends a new email, not a reply; the request keeps its attempt, date and status", async () => {
    const { a, first } = await sentToWrongAddress();
    const draft = prepareResend(db, ops, { emailId: first.id });
    const resendId = queueResend(
      db,
      ops,
      { emailId: first.id, to: ["dogru@msc.example"], cc: [], bcc: draft.bcc, subject: draft.subject, body: draft.body, documentIds: [draft.attachments[0].documentId] },
      later(2),
    );
    const { transport, sent } = fakeTransport();
    await runJobs(transport, later(2));
    expect(sent).toHaveLength(1);
    expect(sent[0].envelope.to).toContain("dogru@msc.example");
    expect(sent[0].raw).not.toContain("In-Reply-To");
    // Only the kept attachment: the form, not the receipt.
    expect(sent[0].raw).toContain("formu_MEDU1000001");
    expect(sent[0].raw).not.toContain("Dekont");
    expect(db.select().from(emails).where(eq(emails.id, resendId)).get()).toMatchObject({ sendStatus: "SENT", resendOfEmailId: first.id, inReplyTo: null, references: [] });

    const rows = db.select().from(requests).all();
    expect(rows).toEqual([expect.objectContaining({ emailId: first.id, attemptNo: 1, requestedOn: "2026-10-22", sendStatus: "SENT" })]);
    expect(listAllBls(db, ops, later(2))[0]).toMatchObject({ status: "REQUESTED", attempts: 1, lastRequestOn: "2026-10-22" });
    const detail = getBlDetail(db, ops, a, later(2));
    expect(detail.emails.map((e) => [e.id, e.resendOfEmailId])).toEqual([[resendId, first.id], [first.id, null]]);
    expect(detail.timeline.map((e) => e.action).slice(0, 2)).toEqual(["request.resent", "request.resend"]);
  });

  it("links the agency's reply to the resend to the B/L; the next follow-up replies to the resend", async () => {
    const { a, first } = await sentToWrongAddress();
    const draft = prepareResend(db, ops, { emailId: first.id });
    const resendId = queueResend(db, ops, { emailId: first.id, to: ["dogru@msc.example"], cc: [], bcc: [], subject: draft.subject, body: draft.body, documentIds: [] }, later(2));
    await runJobs(fakeTransport().transport, later(2));
    const resend = db.select().from(emails).where(eq(emails.id, resendId)).get()!;

    // The follow-up (Thursday 29 Oct) replies to the resend, which reached the right people.
    const [followUp] = prepareRequestEmails(db, ops, { blIds: [a] }, new Date("2026-10-29T09:00:00Z"));
    expect(followUp).toMatchObject({ thread: { messageId: resend.messageId }, items: [{ attemptNo: 2 }] });
    expect(followUp.body).toContain("Kime: dogru@msc.example");

    db.transaction((tx) =>
      importMessage(
        tx,
        { messageId: "<cevap-1@msc.example>", inReplyTo: resend.messageId, references: [resend.messageId], from: "dogru@msc.example", to: ["depozito@firma.com.tr"], cc: [], subject: `Re: ${resend.subject}`, text: "Konteynerler henüz dönmedi.", attachments: [] },
        { raw: Buffer.from("raw"), receivedAt: later(3) },
        {},
        later(3),
      ),
    );
    const reply = db.select().from(emails).where(eq(emails.messageId, "<cevap-1@msc.example>")).get()!;
    expect(db.select().from(emailBlLinks).where(eq(emailBlLinks.emailId, reply.id)).all()).toEqual([expect.objectContaining({ blId: a, linkedBy: "THREAD" })]);
  });

  it("is refused for emails that were not sent requests, foreign attachments and closed B/Ls", async () => {
    const { a, first } = await sentToWrongAddress();
    const base = { emailId: first.id, to: ["dogru@msc.example"], cc: [], bcc: [], subject: "Konu", body: "Metin" };
    expect(() => queueResend(db, ops, { ...base, documentIds: [storeUpload(db, ops, { originalName: "baska.pdf", content: PDF, kind: "FORM" }, NOW).id] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "requests.errors.attachment" }),
    );
    // Resending a resend repeats the original.
    const resendId = queueResend(db, ops, { ...base, documentIds: [] }, NOW);
    expect(prepareResend(db, ops, { emailId: resendId }).resendOfEmailId).toBe(first.id);
    // A request email that never went out is not resent; it is retried or sent as a request.
    db.update(emails).set({ sendStatus: "FAILED" }).where(eq(emails.id, first.id)).run();
    expect(() => prepareResend(db, ops, { emailId: first.id })).toThrow(expect.objectContaining({ messageKey: "requests.errors.resendNotSent" }));
    db.update(emails).set({ sendStatus: "SENT" }).where(eq(emails.id, first.id)).run();
    voidBl(db, ops, { id: a, reason: "Yanlış kayıt" }, NOW);
    expect(() => prepareResend(db, ops, { emailId: first.id })).toThrow(expect.objectContaining({ messageKey: "requests.errors.resendClosed" }));
  });
});
