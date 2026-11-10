import { eq } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { documents, emails } from "@/server/db/schema";
import { archiveEmail, messageFromMsg } from "@/server/email/archive";
import { ForbiddenError } from "@/server/errors";
import { undoActions } from "@/server/undo";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl } from "../support/records";

const NOW = new Date("2026-11-10T09:00:00Z");

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let blId: number;
let other: number;

const eml = async (overrides: { messageId?: string; subject?: string } = {}) =>
  new MailComposer({
    from: "iade@msc.example",
    to: "depozito@firma.com.tr",
    subject: overrides.subject ?? "RE: MEDU1000001 depozito iadesi",
    text: "Konteynerler henüz iade edilmedi.",
    messageId: overrides.messageId ?? "<reply-1@msc.example>",
    inReplyTo: "<request-1@firma.com.tr>",
    date: new Date("2026-11-05T08:30:00Z"),
    attachments: [{ filename: "döküm.pdf", content: Buffer.from("%PDF-1.4 test") }],
  })
    .compile()
    .build();

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  const msc = makeAgency(db, ops, "MSC");
  blId = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 100000, paidAt: "2026-10-01" }, NOW).blId;
  other = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000002", amountMinor: 100000, paidAt: "2026-10-01" }, NOW).blId;
});

describe("archiving an email from Outlook on a B/L", () => {
  it("stores the original file, its attachments and the message, and links it to the B/L", async () => {
    const auditIds = await archiveEmail(db, ops, { blId, fileName: "RE MEDU1000001.eml", content: await eml() }, NOW);
    expect(auditIds).toHaveLength(1);
    const email = db.select().from(emails).get()!;
    expect(email).toMatchObject({
      direction: "IN",
      messageId: "<reply-1@msc.example>",
      inReplyTo: "<request-1@firma.com.tr>",
      fromAddress: "iade@msc.example",
      subject: "RE: MEDU1000001 depozito iadesi",
      receivedAt: "2026-11-05T08:30:00.000Z",
    });
    // The original file is kept as dropped, so it opens in Outlook again.
    expect(db.select().from(documents).where(eq(documents.id, email.rawDocumentId!)).get()).toMatchObject({ originalName: "RE MEDU1000001.eml", mimeType: "message/rfc822" });
    const detail = getBlDetail(db, ops, blId, NOW);
    expect(detail.emails).toEqual([expect.objectContaining({ id: email.id, attachments: [expect.objectContaining({ originalName: "döküm.pdf" })] })]);
  });

  it("links an email archived before to another B/L without storing it twice; undo takes the link back", async () => {
    await archiveEmail(db, ops, { blId, fileName: "a.eml", content: await eml() }, NOW);
    const [auditId] = await archiveEmail(db, ops, { blId: other, fileName: "a.eml", content: await eml() }, NOW);
    expect(db.select().from(emails).all()).toHaveLength(1);
    expect(getBlDetail(db, ops, other, NOW).emails).toHaveLength(1);
    await expect(archiveEmail(db, ops, { blId: other, fileName: "a.eml", content: await eml() }, NOW)).rejects.toMatchObject({ messageKey: "archive.errors.alreadyLinked" });
    undoActions(db, ops, { auditIds: [auditId] }, NOW);
    expect(getBlDetail(db, ops, other, NOW).emails).toHaveLength(0);
  });

  it("refuses other file types, unreadable files and other roles", async () => {
    await expect(archiveEmail(db, ops, { blId, fileName: "not-mail.pdf", content: Buffer.from("%PDF") }, NOW)).rejects.toMatchObject({ messageKey: "archive.errors.type" });
    await expect(archiveEmail(db, ops, { blId, fileName: "broken.msg", content: Buffer.from("not an outlook file") }, NOW)).rejects.toMatchObject({
      messageKey: "archive.errors.unreadable",
    });
    await expect(archiveEmail(db, acc, { blId, fileName: "a.eml", content: await eml() }, NOW)).rejects.toThrow(ForbiddenError);
  });
});

describe("reading an Outlook .msg", () => {
  it("takes sender, recipients, thread headers, date, text and visible attachments", () => {
    const fields = {
      messageId: "<msg-1@msc.example>",
      headers: "Message-ID: <msg-1@msc.example>\r\nIn-Reply-To: <request-1@firma.com.tr>\r\nReferences: <request-0@firma.com.tr>\r\n <request-1@firma.com.tr>\r\n",
      senderSmtpAddress: "Iade@MSC.example",
      recipients: [
        { recipType: "to" as const, smtpAddress: "depozito@firma.com.tr" },
        { recipType: "cc" as const, email: "muhasebe@firma.com.tr" },
      ],
      subject: "RE: MEDU1000001",
      body: "Onaylandı.",
      messageDeliveryTime: "Thu, 05 Nov 2026 08:30:00 GMT",
      attachments: [{ fileName: "logo.png", attachmentHidden: true }, { fileName: "döküm.pdf" }],
    };
    const message = messageFromMsg(fields, (a) => ({ fileName: String(a.fileName), content: new Uint8Array([1, 2, 3]) }), Buffer.from("x"));
    expect(message).toMatchObject({
      messageId: "<msg-1@msc.example>",
      inReplyTo: "<request-1@firma.com.tr>",
      references: ["<request-0@firma.com.tr>", "<request-1@firma.com.tr>"],
      from: "iade@msc.example",
      to: ["depozito@firma.com.tr"],
      cc: ["muhasebe@firma.com.tr"],
      subject: "RE: MEDU1000001",
      text: "Onaylandı.",
      date: new Date("2026-11-05T08:30:00Z"),
    });
    expect(message.attachments.map((a) => a.filename)).toEqual(["döküm.pdf"]);
  });
});
