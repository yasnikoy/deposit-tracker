import fs from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { updateBl, voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { agencies, auditLog, documents } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { documentPath, storeUpload } from "@/server/files";
import { currentBlForm, generateBlForm, setAgencyFormTemplate, uploadBlForm } from "@/server/forms";
import { saveBankAccount } from "@/server/lists";
import { createTestDb, makeUser } from "../support/db";
import { docxText, makeDocx } from "../support/docx";
import { makeAgency, makeBl, PDF } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");
const TEMPLATE = makeDocx([
  "{agency_name} – Depozito İade Talep Formu",
  "B/L: {bl_no} ({container_count} konteyner: {containers})",
  "Tutar: {amount} {currency}, ödeme tarihi {paid_at}",
  "Banka: {bank_name} IBAN: {iban}",
  "Tarih: {today}",
]);

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let agencyId: number;
let blId: number;

const uploadAs = (user: AuthUser, kind: "FORM" | "FORM_TEMPLATE", name: string, content: Buffer) =>
  storeUpload(db, user, { originalName: name, content, kind }, NOW);
const account = (iban: string, currency = "USD", active = true) =>
  saveBankAccount(db, admin, { name: `Hesap ${iban}`, bankName: "Örnek Bank", iban, currency, active, reason: null }, NOW);

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  agencyId = makeAgency(db, ops, "MSC Şahin");
  blId = makeBl(
    db,
    { acc, ops },
    { agencyId, blNo: "MEDU1000001", amountMinor: 300050, paidAt: "2026-10-01", containers: ["MSCU1234565", "CSQU3054383"] },
    NOW,
  ).blId;
});

describe("agency form template", () => {
  it("is set by an admin from an uploaded .docx with known placeholders", () => {
    const doc = uploadAs(admin, "FORM_TEMPLATE", "msc-form.docx", TEMPLATE);
    expect(() => setAgencyFormTemplate(db, ops, { agencyId, documentId: doc.id }, NOW)).toThrow(ForbiddenError);
    setAgencyFormTemplate(db, admin, { agencyId, documentId: doc.id }, NOW);
    expect(db.select().from(agencies).where(eq(agencies.id, agencyId)).get()?.formTemplateDocumentId).toBe(doc.id);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "agency.formTemplate")).get()).toMatchObject({ roleUsed: "ADMIN" });
  });

  it("reports unknown placeholders and loops, and refuses the template", () => {
    const doc = uploadAs(admin, "FORM_TEMPLATE", "x.docx", makeDocx(["{bl_no} {imza}", "{#containers}{no}{/containers}"]));
    expect(() => setAgencyFormTemplate(db, admin, { agencyId, documentId: doc.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "forms.errors.unknownPlaceholders", params: { list: "{imza}, {#containers}, {no}, {/containers}" } }),
    );
  });

  it("refuses broken templates and other file types", () => {
    const broken = uploadAs(admin, "FORM_TEMPLATE", "broken.docx", makeDocx(["{bl_no"]));
    expect(() => setAgencyFormTemplate(db, admin, { agencyId, documentId: broken.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "forms.errors.invalidTemplate" }),
    );
    const pdf = uploadAs(admin, "FORM_TEMPLATE", "form.pdf", PDF);
    expect(() => setAgencyFormTemplate(db, admin, { agencyId, documentId: pdf.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "forms.errors.templateType" }),
    );
  });
});

describe("prefilled form", () => {
  beforeEach(() => {
    setAgencyFormTemplate(db, admin, { agencyId, documentId: uploadAs(admin, "FORM_TEMPLATE", "msc.docx", TEMPLATE).id }, NOW);
  });

  const generatedText = (documentId: number) => {
    const doc = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    return docxText(fs.readFileSync(documentPath(doc)));
  };

  it("fills the template from the B/L and the single active account in its currency", () => {
    account("TR330006100519786457841326");
    account("TR320010009999999999999999", "EUR");
    account("TR760006400000112345678901", "USD", false);
    expect(() => generateBlForm(db, acc, { blId }, NOW)).toThrow(ForbiddenError);

    const form = generateBlForm(db, ops, { blId }, NOW);
    expect(form).toMatchObject({ originalName: "İade formu MEDU1000001.docx", bankAccountWarning: null });
    expect(generatedText(form.documentId)).toEqual([
      "MSC Şahin – Depozito İade Talep Formu",
      "B/L: MEDU1000001 (2 konteyner: MSCU1234565, CSQU3054383)",
      "Tutar: 3.000,50 USD, ödeme tarihi 01.10.2026",
      "Banka: Örnek Bank IBAN: TR330006100519786457841326",
      "Tarih: 22.10.2026",
    ]);
    expect(getBlDetail(db, ops, blId, NOW).documents.map((d) => d.kind)).toEqual(["GENERATED_FORM"]);
    expect(getBlDetail(db, ops, blId, NOW).timeline.map((e) => e.action)).toContain("form.generate");
  });

  it("fills a placeholder that Word split across formatting runs", () => {
    const split = uploadAs(admin, "FORM_TEMPLATE", "split.docx", makeDocx([["B/L: {bl", "_n", "o}"]]));
    setAgencyFormTemplate(db, admin, { agencyId, documentId: split.id }, NOW);
    expect(generatedText(generateBlForm(db, ops, { blId }, NOW).documentId)).toEqual(["B/L: MEDU1000001"]);
  });

  it("leaves the bank fields blank and warns when no account or several accounts match", () => {
    let form = generateBlForm(db, ops, { blId }, NOW);
    expect(form.bankAccountWarning).toBe("none");
    expect(generatedText(form.documentId)[3]).toBe("Banka:  IBAN: ");

    account("TR330006100519786457841326");
    account("TR760006400000112345678901");
    form = generateBlForm(db, ops, { blId }, NOW);
    expect(form.bankAccountWarning).toBe("several");
  });

  it("needs a template, and an active B/L", () => {
    const other = makeAgency(db, ops, "Maersk");
    const otherBl = makeBl(db, { acc, ops }, { agencyId: other, blNo: "MAEU2000002", amountMinor: 100000, paidAt: "2026-10-02" }, NOW).blId;
    expect(() => generateBlForm(db, ops, { blId: otherBl }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "forms.errors.noTemplate", params: { agency: "Maersk" } }),
    );
    voidBl(db, ops, { id: blId, reason: "Yanlış kayıt" }, NOW);
    expect(() => generateBlForm(db, ops, { blId }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.voided" }));
  });
});

describe("uploaded form", () => {
  it("attaches the signed scan to the B/L; a newer upload becomes the current form", () => {
    const first = uploadAs(ops, "FORM", "imzali-form.pdf", PDF);
    expect(() => uploadBlForm(db, acc, { blId, documentId: first.id }, NOW)).toThrow(ForbiddenError);
    uploadBlForm(db, ops, { blId, documentId: first.id }, NOW);
    expect(currentBlForm(db, blId)?.id).toBe(first.id);

    const second = uploadAs(ops, "FORM", "imzali-form-2.pdf", PDF);
    uploadBlForm(db, ops, { blId, documentId: second.id }, NOW);
    expect(currentBlForm(db, blId)?.id).toBe(second.id);
    // A document can be attached once, and only by its uploader.
    expect(() => uploadBlForm(db, ops, { blId, documentId: second.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "files.errors.evidence" }),
    );
    expect(getBlDetail(db, ops, blId, NOW).timeline.filter((e) => e.action === "form.upload")).toHaveLength(2);
    // Containers can still be edited after a form exists.
    updateBl(db, ops, { id: blId, blNo: "MEDU1000001", containers: [] }, NOW);
  });
});
