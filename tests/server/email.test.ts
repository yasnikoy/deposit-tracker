import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail, listAllBls } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { auditLog, emailBlLinks, emails, jobs, requests } from "@/server/db/schema";
import { cancelRequestEmails, prepareRequestEmails, type EmailDraft } from "@/server/email/compose";
import { emailJobHandlers, queueRequestEmail, sendTestEmail } from "@/server/email/send";
import { getEmailTemplate, seedEmailTemplates, updateEmailTemplate } from "@/server/email/templates";
import type { Envelope, MailTransport } from "@/server/email/transport";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { createBls } from "@/server/bls";
import { attachPaymentEvidence, createPayment } from "@/server/payments";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { listDueRequests } from "@/server/requests";
import { mailOutages } from "@/server/service-status";
import { updateSettings } from "@/server/settings";
import { setStandingDocument } from "@/server/standing-documents";
import { createTestDb, makeUser, SEED_FILE } from "../support/db";
import { makeAgency, makeBl, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

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
let ops2: AuthUser;
let msc: number;
let maersk: number;

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
  ops2 = await makeUser(db, "ops2", ["OPERATIONS"]);
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
  maersk = makeAgency(db, ops, "Maersk", { toRecipients: ["refund@maersk.example"], batchSending: true });
});

describe("preparing request emails", () => {
  it("fills the template, recipients and attachments: form, deposit receipt and standing documents", () => {
    const a = bl(msc, "MEDU1000001", "2026-10-01", ["MSCU1234565"]);
    attachForm(a);
    setStandingDocument(db, admin, { slot: "SIGNATURE_CIRCULAR", documentId: storeUpload(db, admin, { originalName: "imza-sirkuleri.pdf", content: PDF, kind: "STANDING" }, NOW).id }, NOW);

    expect(() => prepareRequestEmails(db, acc, { blIds: [a] }, NOW)).toThrow(ForbiddenError);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    expect(draft).toMatchObject({
      agencyName: "MSC",
      to: ["iade@msc.example"],
      cc: ["muhasebe@msc.example"],
      bcc: ["arsiv@firma.com.tr"],
      subject: "Depozito İade Talebi – MEDU1000001",
      thread: null,
      items: [{ blId: a, blNo: "MEDU1000001", kind: "FIRST", attemptNo: 1 }],
    });
    expect(draft.body).toContain("MEDU1000001 numaralı konşimentoya ait MSCU1234565 numaralı konteyner(ler)");
    expect(draft.body).toContain("3.000,00 USD");
    expect(draft.body).toContain("Firma A.Ş. Operasyon");
    expect(draft.attachments.map((x) => [x.kind, x.originalName])).toEqual([
      ["FORM", "İade formu MEDU1000001.pdf"],
      ["RECEIPT", "Dekont MEDU1000001.pdf"],
      ["STANDING", "imza-sirkuleri.pdf"],
    ]);
  });

  it("refuses B/Ls without a form, not yet due and agencies without recipients", () => {
    const noForm = bl(msc, "MEDU1000001");
    expect(() => prepareRequestEmails(db, ops, { blIds: [noForm] }, NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.formMissing" }));
    const fresh = bl(msc, "MEDU1000002", "2026-10-22");
    attachForm(fresh);
    expect(() => prepareRequestEmails(db, ops, { blIds: [fresh] }, NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.notDueBl" }));
    const silent = makeAgency(db, ops, "Alıcısız");
    const s = bl(silent, "SLNT1000001");
    attachForm(s);
    expect(() => prepareRequestEmails(db, ops, { blIds: [s] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "requests.errors.noRecipients", params: { agency: "Alıcısız" } }),
    );
  });

  it("locks the B/Ls for the drafting user until sent, cancelled or timed out", () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    expect(() => prepareRequestEmails(db, ops2, { blIds: [a] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "requests.errors.locked", params: { bl: "MEDU1000001", user: "OPS" } }),
    );
    expect(listDueRequests(db, ops2, NOW).DUE[0].rows[0].lockedBy).toBe("OPS");
    expect(listDueRequests(db, ops, NOW).DUE[0].rows[0].lockedBy).toBeNull();
    // After the draft lock timeout (30 minutes) another user may take over.
    expect(() => prepareRequestEmails(db, ops2, { blIds: [a] }, minutes(31))).not.toThrow();
    cancelRequestEmails(db, ops2, { blIds: [a] });
    expect(() => prepareRequestEmails(db, ops, { blIds: [a] }, NOW)).not.toThrow();
  });

  it("puts a batch agency's first requests in one email with a line per B/L", () => {
    const a = bl(maersk, "MAEU1000001", "2026-10-01", ["MSCU1234565"]);
    const b = bl(maersk, "MAEU1000002", "2026-10-02");
    attachForm(a, "form-a.pdf");
    attachForm(b, "form-b.pdf");
    const drafts = prepareRequestEmails(db, ops, { blIds: [b, a] }, NOW);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("Depozito Talepleri – MAEU1000001, MAEU1000002");
    expect(drafts[0].body).toContain("Aşağıdaki konşimentolara ait depozito iadelerini rica ederiz:\n• MAEU1000001 – MSCU1234565 – 3.000,00 USD\n• MAEU1000002 –  – 3.000,00 USD");
    // The empty deduction-statement section is left out with its intro line.
    expect(drafts[0].body).not.toContain("kesinti dökümünü");
    expect(drafts[0].attachments.map((x) => x.originalName)).toEqual([
      "İade formu MAEU1000001.pdf",
      "Dekont MAEU1000001.pdf",
      "İade formu MAEU1000002.pdf",
      "Dekont MAEU1000002.pdf",
    ]);
    // A non-batch agency gets one email per B/L.
    const c = bl(msc, "MEDU1000003");
    const d = bl(msc, "MEDU1000004");
    attachForm(c);
    attachForm(d);
    expect(prepareRequestEmails(db, ops, { blIds: [c, d] }, NOW)).toHaveLength(2);
  });
});

describe("sending", () => {
  it("queues the previewed email with the user's edits; the job sends it and moves the B/L to REQUESTED", async () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    const receipt = draft.attachments.find((x) => x.kind === "RECEIPT")!;
    const emailId = send(draft, ops, { subject: `${draft.subject} (acil)`, documentIds: [receipt.documentId] });

    // Queued: hidden from the due list, not yet sent.
    expect(listDueRequests(db, ops, NOW).DUE).toEqual([]);
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ status: "DUE", attempts: 0 });

    const { transport, sent, appended } = fakeTransport();
    expect(await runJobs(transport)).toBe(2); // the send, then the sent-folder copy
    expect(sent).toHaveLength(1);
    expect(sent[0].envelope).toEqual({ from: "depozito@firma.com.tr", to: ["iade@msc.example", "muhasebe@msc.example", "arsiv@firma.com.tr"] });
    // Encoded and folded: "Depozito İade Talebi – MEDU1000001 (acil)".
    expect(sent[0].raw).toContain("Subject: =?UTF-8?Q?Depozito_=C4=B0ade_Talebi_=E2=80=93_MEDU?=");
    expect(sent[0].raw).toContain("=?UTF-8?Q?1000001_=28acil=29?=");
    expect(sent[0].raw).toContain('filename="Dekont MEDU1000001.pdf"');
    // Only the receipt was kept in the preview.
    expect(sent[0].raw.match(/Content-Disposition: attachment/g)).toHaveLength(1);
    expect(sent[0].raw).not.toContain("arsiv@firma.com.tr"); // BCC is not a header
    expect(appended).toEqual([sent[0].raw]);

    const email = db.select().from(emails).where(eq(emails.id, emailId)).get()!;
    expect(email).toMatchObject({ sendStatus: "SENT", dryRun: false, subject: `${draft.subject} (acil)` });
    expect(email.copiedToSentAt).not.toBeNull();
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ status: "REQUESTED", attempts: 1, lastRequestOn: "2026-10-22" });
    expect(getBlDetail(db, ops, a, NOW).timeline.map((e) => e.action).slice(0, 2)).toEqual(["request.sent", "request.queue"]);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "request.sent")).get()).toMatchObject({ actorUserId: ops.id, roleUsed: "OPERATIONS" });
  });

  it("in dry-run stores the message and moves the B/L, but nothing reaches a mail server", async () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    send(draft);
    const { transport, sent, appended } = fakeTransport({ dryRun: true });
    await runJobs(transport);
    expect(db.select().from(emails).get()).toMatchObject({ sendStatus: "SENT", dryRun: true });
    expect(appended).toEqual([]);
    expect(db.select().from(jobs).all().map((j) => j.kind)).toEqual(["SEND_EMAIL"]);
    // The fake still saw the message, as the dry-run transport logs it.
    expect(sent).toHaveLength(1);
    expect(listAllBls(db, ops, NOW)[0].status).toBe("REQUESTED");
  });

  it("retries three times with backoff, then marks the request failed; the B/L becomes due again", async () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    send(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0]);
    const { transport } = fakeTransport({ failures: 10 });

    await runJobs(transport);
    expect(mailOutages(db)).toEqual([{ service: "SMTP", since: NOW.toISOString() }]);
    expect(await runJobs(transport, minutes(0.5))).toBe(0); // the retry waits a minute
    await runJobs(transport, minutes(1));
    await runJobs(transport, minutes(6));
    expect(db.select().from(requests).get()?.sendStatus).toBe("QUEUED");
    await runJobs(transport, minutes(21));
    expect(db.select().from(requests).get()).toMatchObject({ sendStatus: "FAILED", failureReason: "connect ECONNREFUSED" });
    expect(db.select().from(emails).get()).toMatchObject({ sendStatus: "FAILED", sendAttempts: 4 });
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ status: "DUE", attempts: 0 });
    expect(listDueRequests(db, ops, NOW).FAILED.map((f) => f.blNo)).toEqual(["MEDU1000001"]);

    // A new send of the same attempt is allowed and clears the failed entry and the outage.
    send(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0]);
    await runJobs(fakeTransport().transport, minutes(22));
    expect(listDueRequests(db, ops, NOW).FAILED).toEqual([]);
    expect(mailOutages(db)).toEqual([]);
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ status: "REQUESTED", attempts: 1 });
  });

  it("re-checks the draft on the server: no foreign attachments, no other B/Ls, a sender address", () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    const foreign = storeUpload(db, ops, { originalName: "baska.pdf", content: PDF, kind: "OTHER" }, NOW);
    expect(() => send(draft, ops, { documentIds: [foreign.id] })).toThrow(expect.objectContaining({ messageKey: "requests.errors.attachment" }));
    expect(() => send(draft, ops2)).toThrow(expect.objectContaining({ messageKey: "requests.errors.locked" }));
    expect(() => send(draft, acc)).toThrow(ForbiddenError);
    updateSettings(db, admin, { changes: [{ key: "email.maxAttachmentMb", value: 1 }] }, NOW);
    const big = storeUpload(db, ops, { originalName: "buyuk.pdf", content: Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]), kind: "FORM" }, NOW);
    uploadBlForm(db, ops, { blId: a, documentId: big.id }, NOW);
    const [withBig] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    expect(() => send(withBig)).toThrow(expect.objectContaining({ messageKey: "requests.errors.tooLarge" }));
    updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "" }] }, NOW);
    expect(() => send(withBig, ops, { documentIds: [] })).toThrow(expect.objectContaining({ messageKey: "requests.errors.noSender" }));
  });
});

describe("a payment without its receipt", () => {
  it("still yields a B/L; its request warns and goes only once confirmed, and the receipt can follow later", async () => {
    const payment = createPayment(
      db,
      acc,
      { agencyId: msc, amountMinor: 300000, currency: "USD", paidAt: "2026-10-01", kind: "BANK", blNoHint: null, evidenceDocumentId: null, queueItemId: null, confirmDuplicate: true },
      NOW,
    );
    if (payment.status !== "created") throw new Error("payment not created");
    const a = createBls(db, ops, [{ paymentId: payment.id, blNo: "MEDU1000009", containers: [] }], NOW).created[0].blId;
    attachForm(a);
    expect(listDueRequests(db, ops, NOW).DUE[0].rows[0]).toMatchObject({ blId: a, evidenceMissing: true });

    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, NOW);
    expect(draft.missingEvidence).toEqual(["MEDU1000009"]);
    expect(draft.attachments.map((x) => x.kind)).toEqual(["FORM"]);
    expect(() => send(draft)).toThrow(expect.objectContaining({ messageKey: "requests.errors.evidenceMissing", params: { bls: "MEDU1000009" } }));
    send(draft, ops, { confirmMissingEvidence: true });
    const { transport } = fakeTransport();
    await runJobs(transport);
    expect(getBlDetail(db, ops, a, NOW).bl.status).toBe("REQUESTED");

    // Attached later, by operations from the B/L; another accountant may not touch the record.
    const acc2 = await makeUser(db, "acc2", ["ACCOUNTANT"]);
    expect(() => attachPaymentEvidence(db, acc2, { paymentId: payment.id, documentId: storeUpload(db, acc2, { originalName: "d.pdf", content: PDF, kind: "RECEIPT" }, NOW).id }, NOW)).toThrow(ForbiddenError);
    const invoice = storeUpload(db, ops, { originalName: "fatura.pdf", content: PDF, kind: "INVOICE" }, NOW).id;
    expect(() => attachPaymentEvidence(db, ops, { paymentId: payment.id, documentId: invoice }, NOW)).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    const receipt = storeUpload(db, ops, { originalName: "banka.pdf", content: PDF, kind: "RECEIPT" }, NOW).id;
    attachPaymentEvidence(db, ops, { paymentId: payment.id, documentId: receipt }, NOW);
    const detail = getBlDetail(db, ops, a, NOW);
    expect(detail.payment).toMatchObject({ evidenceDocumentId: receipt, evidenceName: "Dekont MEDU1000009.pdf" });
    expect(detail.timeline.map((e) => e.action)).toContain("payment.attachEvidence");
    expect(() => attachPaymentEvidence(db, acc, { paymentId: payment.id, documentId: receipt }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.evidenceExists" }),
    );
  });
});

describe("follow-ups", () => {
  it("reply in the thread of the earlier request, with the follow-up template and attempt number", async () => {
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    send(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0]);
    await runJobs(fakeTransport().transport);
    const first = db.select().from(emails).get()!;

    // Thursday 22 Oct + 5 business days = Thursday 29 Oct.
    const later = new Date("2026-10-29T09:00:00Z");
    const [draft] = prepareRequestEmails(db, ops, { blIds: [a] }, later);
    expect(draft).toMatchObject({
      subject: "Re: Depozito İade Talebi – MEDU1000001",
      items: [{ kind: "FOLLOW_UP", attemptNo: 2 }],
      thread: { messageId: first.messageId },
    });
    expect(draft.body).toContain("2. kez yazıyoruz");
    // Like Outlook's "Reply all": the earlier email below the new text.
    const [newText, quoted] = draft.body.split("-----Özgün İleti-----");
    expect(newText).toContain("2. kez yazıyoruz");
    expect(quoted).toBe(
      [
        "",
        "Kimden: Firma Depozito <depozito@firma.com.tr>",
        "Gönderildi: 22.10.2026 12:00",
        "Kime: iade@msc.example",
        "Bilgi: muhasebe@msc.example",
        "Konu: Depozito İade Talebi – MEDU1000001",
        "",
        first.bodyText,
      ].join("\n"),
    );
    queueRequestEmail(db, ops, { blIds: [a], to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, documentIds: [] }, later);
    const { transport, sent } = fakeTransport();
    await runJobs(transport, later);
    expect(sent[0].raw).toContain(`In-Reply-To: ${first.messageId}`);
    expect(sent[0].raw).toContain(`References: ${first.messageId}`);
    expect(listAllBls(db, ops, later)[0]).toMatchObject({ status: "REQUESTED", attempts: 2 });
  });

  it("of a batch agency share one reply per thread", async () => {
    const [a, b, c] = ["MAEU1000001", "MAEU1000002", "MAEU1000003"].map((no) => bl(maersk, no));
    [a, b, c].forEach((id) => attachForm(id));
    send(prepareRequestEmails(db, ops, { blIds: [a, b] }, NOW)[0]);
    send(prepareRequestEmails(db, ops, { blIds: [c] }, NOW)[0]);
    await runJobs(fakeTransport().transport);

    const later = new Date("2026-10-29T09:00:00Z");
    const drafts = prepareRequestEmails(db, ops, { blIds: [a, b, c] }, later);
    expect(drafts.map((d) => d.items.map((i) => i.blNo))).toEqual([["MAEU1000001", "MAEU1000002"], ["MAEU1000003"]]);
    expect(drafts[0].subject).toBe("Re: Depozito Talepleri – MAEU1000001, MAEU1000002");
    expect(drafts[1].subject).toBe("Re: Depozito İade Talebi – MAEU1000003");
    // The earlier batch email had no CC, so the quote header leaves the line out.
    expect(drafts[0].body).toContain("Kime: refund@maersk.example\nKonu: Depozito Talepleri – MAEU1000001, MAEU1000002");
  });

  it("of a portal agency go by email too, as a new email when nothing is linked", async () => {
    const portal = makeAgency(db, ops, "Portal", { requestChannel: "PORTAL", portalUrl: "https://p.example", toRecipients: ["p@p.example"] });
    const p = bl(portal, "PRTL1000001");
    attachForm(p);
    send(prepareRequestEmails(db, ops, { blIds: [p] }, NOW)[0], ops, { confirmPortalFiled: true });
    await runJobs(fakeTransport().transport);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [p] }, new Date("2026-10-29T09:00:00Z"));
    expect(draft).toMatchObject({ subject: "Re: Depozito İade Talebi – PRTL1000001", portalFiling: [] });
  });
});

describe("portal agencies", () => {
  let portal: number;
  beforeEach(() => {
    portal = makeAgency(db, ops, "Portal", { requestChannel: "PORTAL", portalUrl: "https://p.example", toRecipients: ["p@p.example"] });
  });

  it("file the first request on the portal and send its documents by email: one request, counted once sent", async () => {
    const p = bl(portal, "PRTL1000001");
    attachForm(p);
    expect(listDueRequests(db, ops, NOW).DUE[0].rows[0]).toMatchObject({ blNo: "PRTL1000001", kind: "FIRST", channel: "PORTAL" });
    const [draft] = prepareRequestEmails(db, ops, { blIds: [p] }, NOW);
    expect(draft).toMatchObject({ subject: "Depozito İade Talebi – PRTL1000001", thread: null, portalFiling: ["PRTL1000001"], portalUrl: "https://p.example" });
    expect(draft.attachments.map((a) => a.kind)).toEqual(["FORM", "RECEIPT"]);

    // Not sent before the user confirms the portal filing (checked on the server).
    expect(() => send(draft)).toThrow(expect.objectContaining({ messageKey: "requests.errors.portalNotFiled" }));
    send(draft, ops, { confirmPortalFiled: true });
    expect(listAllBls(db, ops, NOW).find((b) => b.id === p)).toMatchObject({ status: "DUE", attempts: 0 });
    await runJobs(fakeTransport().transport);
    expect(listAllBls(db, ops, NOW).find((b) => b.id === p)).toMatchObject({ status: "REQUESTED", attempts: 1, lastRequestOn: "2026-10-22" });
    expect(db.select().from(auditLog).where(eq(auditLog.action, "request.queue")).get()?.after).toMatchObject({ portalFiled: true });
  });

  it("send the documents as a reply when the agency already wrote about the B/L", () => {
    const p = bl(portal, "PRTL1000002");
    attachForm(p);
    const incoming = db
      .insert(emails)
      .values({ direction: "IN", agencyId: portal, messageId: "<talep-1@p.example>", fromAddress: "p@p.example", to: ["depozito@firma.example"], subject: "Talebiniz alındı – evrak bekleniyor", bodyText: "Evrakları iletiniz.", receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() })
      .returning()
      .get();
    db.insert(emailBlLinks).values({ emailId: incoming.id, blId: p, linkedBy: "MANUAL", linkedByUser: ops.id, createdAt: NOW.toISOString() }).run();
    const [draft] = prepareRequestEmails(db, ops, { blIds: [p] }, NOW);
    expect(draft).toMatchObject({ subject: "Re: Talebiniz alındı – evrak bekleniyor", thread: { messageId: "<talep-1@p.example>" }, portalFiling: ["PRTL1000002"] });
    expect(draft.body).toContain("Evrakları iletiniz.");
  });
});

describe("templates and test email", () => {
  it("uses the edited template for the next draft; templates are admin-only", () => {
    expect(() => updateEmailTemplate(db, ops, { key: "REFUND_REQUEST", subject: "x", body: "y", reason: null })).toThrow(ForbiddenError);
    updateEmailTemplate(db, admin, { key: "REFUND_REQUEST", subject: "İade – {bl_no}", body: "Merhaba {agency_name}", reason: "Kısa metin" }, NOW);
    const a = bl(msc, "MEDU1000001");
    attachForm(a);
    expect(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0]).toMatchObject({ subject: "İade – MEDU1000001", body: "Merhaba MSC" });
  });

  it("follow a release's seed text while nobody has edited them; an edited one is kept", () => {
    updateEmailTemplate(db, admin, { key: "FOLLOW_UP", subject: "Takip – {bl_no}", body: "Bizim metnimiz", reason: null }, NOW);
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    seed.emailTemplates.REFUND_REQUEST = { subject: "Yeni sürüm – {bl_no}", body: "Yeni metin" };
    seed.emailTemplates.FOLLOW_UP = { subject: "Yeni takip – {bl_no}", body: "Yeni takip metni" };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seed-")), "settings.json");
    fs.writeFileSync(file, JSON.stringify(seed));

    expect(seedEmailTemplates(db, file, NOW)).toEqual(["REFUND_REQUEST"]);
    expect(getEmailTemplate(db, "REFUND_REQUEST")).toMatchObject({ subject: "Yeni sürüm – {bl_no}", body: "Yeni metin", updatedBy: null });
    expect(getEmailTemplate(db, "FOLLOW_UP")).toMatchObject({ subject: "Takip – {bl_no}", body: "Bizim metnimiz" });
    const audit = db.select().from(auditLog).where(eq(auditLog.action, "emailTemplate.seed")).all().find((a) => a.entityId === "REFUND_REQUEST" && a.before);
    expect(audit?.after).toEqual({ subject: "Yeni sürüm – {bl_no}", body: "Yeni metin" });
    // Nothing changes on the next start.
    expect(seedEmailTemplates(db, file, NOW)).toEqual([]);
  });

  it("sends a test email through the transport (admin only) and reports failures", async () => {
    const ok = fakeTransport();
    expect(await sendTestEmail(db, admin, { to: "it@firma.com.tr" }, ok.transport, NOW)).toEqual({ dryRun: false });
    expect(ok.sent[0].envelope.to).toEqual(["it@firma.com.tr"]);
    await expect(sendTestEmail(db, ops, { to: "it@firma.com.tr" }, ok.transport, NOW)).rejects.toThrow(ForbiddenError);
    await expect(sendTestEmail(db, admin, { to: "it@firma.com.tr" }, fakeTransport({ failures: 1 }).transport, NOW)).rejects.toMatchObject({
      messageKey: "emailSettings.testFailed",
    });
  });
});
