import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { auditLog, deductionTypes, documents, emailAttachments, emails, requests } from "@/server/db/schema";
import { emailJobHandlers } from "@/server/email/send";
import type { MailTransport } from "@/server/email/transport";
import { DomainError, ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { createRefund } from "@/server/refunds";
import { listSentReports, queueReportEmail, reportEmailDraft, type ReportRequest } from "@/server/report-email";
import { recordPortalRequest } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const usd = (amount: number) => amount * 100;

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let line: number;
let other: number;
let c: number;

function requestedBl(blNo: string, amount: number, currency = "USD"): number {
  const { blId } = makeBl(db, { acc, ops }, { agencyId: line, blNo, paidAt: "2026-08-03", amountMinor: usd(amount), currency }, NOW);
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
  recordPortalRequest(db, ops, { blId, requestedOn: "2026-09-01", portalRef: null }, NOW);
  return blId;
}

const ALL: ReportRequest = {
  sections: ["REQUESTED", "REMAINING", "COLLECTED", "PROBLEMS"],
  filters: { agencyIds: [], currency: null, collectedFrom: "2026-10-01", collectedTo: "2026-10-31" },
};

function fakeTransport() {
  const sent: string[] = [];
  const transport: MailTransport = {
    dryRun: false,
    async send(raw) {
      sent.push(raw.toString("utf8"));
    },
    async appendToSent() {},
  };
  return { transport, sent };
}

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
        { key: "email.fromAddress", value: "depozito@firmagrup.com" },
        { key: "email.signature", value: "Firma A.Ş. Operasyon" },
        { key: "reports.internalDomains", value: ["firma.com.tr"] },
        { key: "reports.defaultRecipients", value: ["mudur@firma.com.tr"] },
      ],
    },
    NOW,
  );
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
  // An agency whose recipient list holds an address in our own domain.
  other = makeAgency(db, ops, "Yerel Acente", { toRecipients: ["acente@firma.com.tr"] });
  const a = requestedBl("HATU1000001", 3000);
  const b = requestedBl("HATU1000002", 2500);
  c = requestedBl("HATU1000003", 1500);
  requestedBl("HATU1000004", 1000);
  requestedBl("HATU1000005", 400, "EUR");
  // Refund 6,300 for A + B + C, value date 21 Oct: C bears an unexplained 700.
  const unexplained = db.select().from(deductionTypes).where(eq(deductionTypes.code, "UNEXPLAINED")).get()!.id;
  const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
  const refund = createRefund(db, acc, { agencyId: line, amountMinor: usd(6300), currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
  if (refund.status !== "created") throw new Error("refund");
  const lines = allocationProposal(db, ops, refund.id).suggestions.fifo.lines.filter((l) => [a, b, c].includes(l.blId));
  confirmAllocation(db, ops, { refundId: refund.id, lines, shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: unexplained }, remainderReason: null }, NOW);
});

describe("report email preview", () => {
  it("summarises each chosen section per agency and currency, with one CSV per section", () => {
    const draft = reportEmailDraft(db, ops, ALL, NOW);
    expect(draft.to).toEqual(["mudur@firma.com.tr"]);
    expect(draft.subject).toBe("Depozito durum raporu – 22.10.2026");
    expect(draft.intro).toContain("22.10.2026 itibarıyla");
    expect(draft.summary).toBe(
      [
        "Talep edilen iadeler",
        "• Hat Lojistik · EUR: 1 B/L, tahsil edilecek 400,00 EUR",
        "• Hat Lojistik · USD: 2 B/L, tahsil edilecek 1.700,00 USD",
        "",
        "Kalan depozitolar",
        "• Hat Lojistik · EUR: 1 B/L, 400,00 EUR",
        "• Hat Lojistik · USD: 2 B/L, 1.700,00 USD",
        "• Toplam EUR: 1 B/L, 400,00 EUR",
        "• Toplam USD: 2 B/L, 1.700,00 USD",
        "",
        "Tahsil edilenler (01.10.2026 – 31.10.2026)",
        "• Hat Lojistik · USD: 3 B/L, tahsil 6.300,00 USD, kesinti 700,00 USD, silinen 0,00 USD",
        "",
        "Sorunlar",
        "• Kesintisi açık: 1 B/L",
        "• İtirazlı: 0 B/L",
        "• Gönderilemeyen talep: 0",
        "• 60 iş gününden uzun bekleyen: 0 B/L",
      ].join("\n"),
    );
    expect(draft.attachments).toEqual([
      { fileName: "Talep edilen iadeler 2026-10-22.csv", rows: 3 },
      { fileName: "Kalan depozitolar 2026-10-22.csv", rows: 3 },
      { fileName: "Tahsil edilenler 2026-10-22.csv", rows: 3 },
      { fileName: "Sorunlar 2026-10-22.csv", rows: 1 },
    ]);
  });

  it("applies the agency and currency filters to every section; an empty section says so", () => {
    const eur = reportEmailDraft(db, ops, { ...ALL, filters: { ...ALL.filters, currency: "EUR" } }, NOW);
    expect(eur.summary).toContain("Tahsil edilenler (01.10.2026 – 31.10.2026)\n• Kayıt yok.");
    expect(eur.attachments.map((a) => a.rows)).toEqual([1, 1, 0, 0]);
    const elsewhere = reportEmailDraft(db, ops, { sections: ["REMAINING"], filters: { ...ALL.filters, agencyIds: [other] } }, NOW);
    expect(elsewhere.summary).toBe("Kalan depozitolar\n• Kayıt yok.");
  });

  it("needs a section, and a valid period for the collected section", () => {
    expect(() => reportEmailDraft(db, ops, { ...ALL, sections: [] }, NOW)).toThrow(DomainError);
    const noPeriod = { ...ALL.filters, collectedFrom: null };
    expect(() => reportEmailDraft(db, ops, { sections: ["COLLECTED"], filters: noPeriod }, NOW)).toThrow(/period/);
    const reversed = { ...ALL.filters, collectedFrom: "2026-10-31", collectedTo: "2026-10-01" };
    expect(() => reportEmailDraft(db, ops, { sections: ["COLLECTED"], filters: reversed }, NOW)).toThrow(/period/);
    // Without the collected section, the period does not matter.
    expect(reportEmailDraft(db, ops, { sections: ["REMAINING"], filters: noPeriod }, NOW).attachments).toHaveLength(1);
  });

  it("is for operations only", () => {
    expect(() => reportEmailDraft(db, acc, ALL, NOW)).toThrow(ForbiddenError);
    expect(() => queueReportEmail(db, admin, { ...ALL, to: ["mudur@firma.com.tr"], cc: [], subject: "x", intro: "y" }, NOW)).toThrow(ForbiddenError);
  });
});

describe("report email sending", () => {
  const send = (to: string[], cc: string[] = []) => queueReportEmail(db, ops, { ...ALL, to, cc, subject: "Depozito durum raporu", intro: "Merhaba,\n\nÖzet aşağıda." }, NOW);

  it("refuses external addresses and anything on an agency's recipient list, before queuing", () => {
    expect(() => send(["mudur@firma.com.tr"], ["dis@gmail.com"])).toThrow(/external/);
    expect(() => send(["acente@firma.com.tr"])).toThrow(/agency/);
    expect(db.select().from(emails).all()).toHaveLength(0);
  });

  it("queues the email with a CSV per section, audits it, and the send job delivers it", async () => {
    // The sender's own domain counts as internal.
    const emailId = send(["mudur@firma.com.tr"], ["ekip@firmagrup.com"]);
    const email = db.select().from(emails).where(eq(emails.id, emailId)).get()!;
    expect(email).toMatchObject({ direction: "OUT", agencyId: null, sendStatus: "QUEUED", to: ["mudur@firma.com.tr"], cc: ["ekip@firmagrup.com"] });
    expect(email.bodyText).toMatch(/^Merhaba,\n\nÖzet aşağıda\.\n\nTalep edilen iadeler\n• Hat Lojistik · EUR/);
    expect(email.bodyText.endsWith("\n\nFirma A.Ş. Operasyon")).toBe(true);

    const files = db.select({ doc: documents }).from(emailAttachments).innerJoin(documents, eq(documents.id, emailAttachments.documentId)).where(eq(emailAttachments.emailId, emailId)).all();
    expect(files.map((f) => [f.doc.originalName, f.doc.mimeType])).toEqual([
      ["Talep edilen iadeler 2026-10-22.csv", "text/csv"],
      ["Kalan depozitolar 2026-10-22.csv", "text/csv"],
      ["Tahsil edilenler 2026-10-22.csv", "text/csv"],
      ["Sorunlar 2026-10-22.csv", "text/csv"],
    ]);
    const audit = db.select().from(auditLog).where(eq(auditLog.action, "report.email")).get()!;
    expect(audit).toMatchObject({ actorUserId: ops.id, roleUsed: "OPERATIONS", entityType: "email", entityId: String(emailId) });
    expect(audit.after).toMatchObject({ sections: ALL.sections, filters: ALL.filters, to: ["mudur@firma.com.tr"], cc: ["ekip@firmagrup.com"] });
    expect(listSentReports(db, acc)).toMatchObject([{ emailId, status: "QUEUED", sentBy: ops.displayName }]);

    const { transport, sent } = fakeTransport();
    await runDueJobs(db, emailJobHandlers(db, () => transport) as JobHandlers, () => NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('filename="Sorunlar 2026-10-22.csv"');
    expect(sent[0]).toContain("Content-Type: text/csv");
    expect(listSentReports(db, acc)[0]).toMatchObject({ status: "SENT", dryRun: false });
    // A report records no requests.
    expect(db.select().from(requests).where(eq(requests.emailId, emailId)).all()).toHaveLength(0);
  });
});
