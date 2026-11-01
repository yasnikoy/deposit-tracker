import { beforeEach, describe, expect, it } from "vitest";
import { openingBalanceSchema, type OpeningBalanceInput } from "@/lib/schemas/opening-balances";
import { allocationProposal } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { prepareRequestEmails } from "@/server/email/compose";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { eq } from "drizzle-orm";
import { agencies, auditLog, billsOfLading, customers } from "@/server/db/schema";
import { createCustomer } from "@/server/customers";
import { attachOpeningBalanceEvidence, createOpeningBalance } from "@/server/opening-balances";
import { prefillFromExtraction } from "@/server/payments";
import { createRefund } from "@/server/refunds";
import { listDueRequests } from "@/server/requests";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;

const receipt = (user = admin, kind: "RECEIPT" | "INVOICE" = "RECEIPT") => storeUpload(db, user, { originalName: "eski-dekont.pdf", content: PDF, kind }, NOW).id;
const input = (overrides: Partial<OpeningBalanceInput> = {}): OpeningBalanceInput =>
  openingBalanceSchema.parse({
    agencyId: msc,
    kind: "BANK",
    amountMinor: 250000,
    currency: "USD",
    paidAt: "2026-07-01",
    blNo: "medu 9000001",
    containers: ["MSCU1234565"],
    documentId: receipt(),
    pastAttempts: 2,
    lastRequestOn: "2026-10-12",
    note: "Excel satır 14",
    ...overrides,
  });

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
});

describe("opening balances", () => {
  it("are entered by an admin only, as a B/L without payment record whose deposit is an opening-balance entry", () => {
    expect(() => createOpeningBalance(db, ops, input(), NOW)).toThrow(ForbiddenError);
    expect(() => createOpeningBalance(db, acc, input(), NOW)).toThrow(ForbiddenError);
    const blId = createOpeningBalance(db, admin, input(), NOW);
    const detail = getBlDetail(db, ops, blId, NOW);
    expect(detail.bl).toMatchObject({ blNo: "MEDU9000001", status: "REQUESTED", depositMinor: 250000, expectedMinor: 250000, attempts: 2, lastRequestOn: "2026-10-12", containers: ["MSCU1234565"] });
    expect(detail.payment).toBeNull();
    expect(detail.openingBalance).toMatchObject({ originalName: "Dekont MEDU9000001.pdf" });
    expect(detail.ledger.map((l) => l.type)).toEqual(["OPENING_BALANCE"]);
    expect(detail.timeline[0]).toMatchObject({ action: "openingBalance.create", reason: "Excel satır 14" });
  });

  it("continue the request chain: the next follow-up is due after the interval, as attempt 3, with the original receipt", () => {
    const blId = createOpeningBalance(db, admin, input(), NOW);
    uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    // Mon 12 Oct + 5 business days = Mon 19 Oct.
    expect(listDueRequests(db, ops, NOW).DUE[0].rows).toEqual([expect.objectContaining({ blId, kind: "FOLLOW_UP", attemptNo: 3, dueDate: "2026-10-19", evidenceMissing: false })]);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [blId] }, NOW);
    // Nothing to reply to and no portal reference: the first-request subject.
    expect(draft).toMatchObject({ thread: null, subject: "Depozito İade Talebi – B/L MEDU9000001", missingEvidence: [] });
    expect(draft.body).toContain("3. kez yazıyoruz");
    expect(draft.attachments.map((a) => [a.kind, a.originalName])).toEqual([
      ["FORM", "İade formu MEDU9000001.pdf"],
      ["RECEIPT", "Dekont MEDU9000001.pdf"],
    ]);
  });

  it("without past requests start as paid, so the first request is due; refunds are allocated to them like any B/L", () => {
    const fresh = createOpeningBalance(db, admin, input({ pastAttempts: 0, lastRequestOn: null }), NOW);
    expect(getBlDetail(db, ops, fresh, NOW).bl.status).toBe("DUE");

    const blId = createOpeningBalance(db, admin, input({ blNo: "MEDU9000002", customerId: testCustomer(db) }), NOW);
    const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const refund = createRefund(db, acc, { agencyId: msc, customerId: testCustomer(db), amountMinor: 250000, currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
    if (refund.status !== "created") throw new Error("refund");
    expect(allocationProposal(db, ops, refund.id).candidates).toEqual([expect.objectContaining({ blId, firstRequestOn: "2026-10-12", expectedMinor: 250000 })]);
  });

  it("need a receipt of the right kind when one is given, a free B/L number and consistent request dates", () => {
    expect(openingBalanceSchema.safeParse({ ...input(), lastRequestOn: null }).success).toBe(false);
    expect(() => createOpeningBalance(db, admin, input({ documentId: receipt(admin, "INVOICE") }), NOW)).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    expect(() => createOpeningBalance(db, admin, input({ documentId: receipt(ops) }), NOW)).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    expect(() => createOpeningBalance(db, admin, input({ lastRequestOn: "2026-06-30" }), NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.beforePayment" }));
    expect(() => createOpeningBalance(db, admin, input({ lastRequestOn: "2026-10-23" }), NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.futureDate" }));
    makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU9000001", paidAt: "2026-10-01", amountMinor: 1000 }, NOW);
    expect(() => createOpeningBalance(db, admin, input(), NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.blNoTaken" }));
  });

  it("wait for the first-request delay after a recent payment, like any B/L", () => {
    // Paid Tue 20 Oct; the first request is due 10 business days later (seed), not at once.
    const blId = createOpeningBalance(db, admin, input({ paidAt: "2026-10-20", pastAttempts: 0, lastRequestOn: null }), NOW);
    expect(getBlDetail(db, ops, blId, NOW).bl.status).toBe("PAID");
    const due = listDueRequests(db, ops, NOW);
    expect(due.DUE.flatMap((g) => g.rows).some((r) => r.blId === blId)).toBe(false);
  });

  it("can be saved without the receipt, which is attached later once (admin or operations)", () => {
    const blId = createOpeningBalance(db, admin, input({ documentId: null }), NOW);
    expect(getBlDetail(db, ops, blId, NOW).openingBalance).toEqual({ documentId: null, originalName: null });
    uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    expect(prepareRequestEmails(db, ops, { blIds: [blId] }, NOW)[0].missingEvidence).toEqual(["MEDU9000001"]);

    expect(() => attachOpeningBalanceEvidence(db, acc, { blId, documentId: receipt(acc) }, NOW)).toThrow(ForbiddenError);
    attachOpeningBalanceEvidence(db, ops, { blId, documentId: receipt(ops) }, NOW);
    expect(getBlDetail(db, ops, blId, NOW).openingBalance).toMatchObject({ originalName: "Dekont MEDU9000001.pdf" });
    expect(db.select().from(auditLog).all().some((a) => a.action === "openingBalance.attachEvidence" && a.roleUsed === "OPERATIONS")).toBe(true);
    expect(() => attachOpeningBalanceEvidence(db, admin, { blId, documentId: receipt() }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.evidenceExists" }),
    );
  });

  it("name a customer: an existing one by name, or a new one registered with the record", () => {
    const first = createOpeningBalance(db, admin, input({ documentId: null, newCustomerName: " Örnek İthalat " }), NOW);
    const registered = db.select().from(customers).all();
    expect(registered).toMatchObject([{ name: "Örnek İthalat", aliases: [], active: true }]);
    const customerOf = (id: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get()!.customerId;
    expect(customerOf(first)).toBe(registered[0].id);
    expect(db.select().from(auditLog).all().find((a) => a.action === "customer.create")).toMatchObject({ roleUsed: "ADMIN" });

    // The next record carries the same name over: no second customer.
    const second = createOpeningBalance(db, admin, input({ blNo: "MEDU9000002", documentId: null, newCustomerName: "örnek ithalat" }), NOW);
    expect(db.select().from(customers).all()).toHaveLength(1);
    expect(customerOf(second)).toBe(registered[0].id);
    expect(openingBalanceSchema.safeParse({ ...input(), customerId: registered[0].id, newCustomerName: "Başka" }).success).toBe(false);
  });

  it("name an agency not in the system yet: added by name under the admin role, reused by the next record", () => {
    const agencyOf = (id: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get()!.agencyId;
    const first = createOpeningBalance(db, admin, input({ agencyId: null, newAgencyName: " Yeni Hat Lojistik ", documentId: null }), NOW);
    const added = db.select().from(agencies).all().find((a) => a.name === "Yeni Hat Lojistik")!;
    expect(agencyOf(first)).toBe(added.id);
    expect(db.select().from(auditLog).all().find((a) => a.action === "agency.create" && a.entityId === String(added.id))).toMatchObject({ roleUsed: "ADMIN" });

    const second = createOpeningBalance(db, admin, input({ agencyId: null, newAgencyName: "yeni hat lojistik", blNo: "MEDU9000002", documentId: null }), NOW);
    expect(agencyOf(second)).toBe(added.id);
    expect(db.select().from(agencies).all()).toHaveLength(2);

    // A rejected record adds no agency; exactly one of an agency or a new name.
    expect(() => createOpeningBalance(db, admin, input({ agencyId: null, newAgencyName: "Başka Hat", blNo: "MEDU9000002", documentId: null }), NOW)).toThrow();
    expect(db.select().from(agencies).all()).toHaveLength(2);
    expect(openingBalanceSchema.safeParse({ ...input(), newAgencyName: "Başka" }).success).toBe(false);
    expect(openingBalanceSchema.safeParse({ ...input(), agencyId: null }).success).toBe(false);
  });

  it("are prefilled from the receipt with customer and file number", () => {
    const beta = createCustomer(db, admin, { name: "Beta Gıda", code: null, aliases: ["BETA"] }, NOW);
    const prefill = prefillFromExtraction(db, { parser: "garanti", description: "BETA T26-00123 MEDU9000003 DEPOZITO", fileNumber: "T26-00123", amountMinor: 100, currency: "USD", date: "2026-10-20" });
    expect(prefill).toMatchObject({ customerId: beta, fileNo: "T26-00123", amountMinor: 100, paidAt: "2026-10-20" });
  });
});
