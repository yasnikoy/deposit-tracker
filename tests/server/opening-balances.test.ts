import { beforeEach, describe, expect, it } from "vitest";
import { openingBalanceSchema, type OpeningBalanceInput } from "@/lib/schemas/opening-balances";
import { allocationProposal } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { updateBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { prepareRequestEmails } from "@/server/email/compose";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { eq } from "drizzle-orm";
import { agencies, auditLog, billsOfLading, customers } from "@/server/db/schema";
import { createCustomer } from "@/server/customers";
import { attachOpeningBalanceEvidence, createOpeningBalance } from "@/server/opening-balances";
import { createPayment, prefillFromExtraction, previewBlJoin } from "@/server/payments";
import { createRefund } from "@/server/refunds";
import { listDueRequests } from "@/server/requests";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF, testCustomer, giveStandingDocuments } from "../support/records";

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
    // Requests attach the customer's documents, so the B/L needs one.
    customerId: testCustomer(db),
    documentId: receipt(),
    pastAttempts: 2,
    lastRequestOn: "2026-10-12",
    note: "Excel satır 14",
    // Records share agency, amount and date here; the duplicate warning has its own test.
    confirmDuplicate: true,
    ...overrides,
  });
/** Saves an opening balance and returns its B/L (a duplicate warning fails the test). */
const created = (...args: Parameters<typeof createOpeningBalance>) => {
  const result = createOpeningBalance(...args);
  if (result.status !== "created") throw new Error(`not created: ${result.status}`);
  return result.blId;
};

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  giveStandingDocuments(db, ops);
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
});

describe("opening balances", () => {
  it("are entered by an admin only, as a B/L without payment record whose deposit is an opening-balance entry", () => {
    expect(() => created(db, ops, input(), NOW)).toThrow(ForbiddenError);
    expect(() => created(db, acc, input(), NOW)).toThrow(ForbiddenError);
    const blId = created(db, admin, input(), NOW);
    const detail = getBlDetail(db, ops, blId, NOW);
    expect(detail.bl).toMatchObject({ blNo: "MEDU9000001", status: "REQUESTED", depositMinor: 250000, expectedMinor: 250000, attempts: 2, lastRequestOn: "2026-10-12", containers: [] });
    expect(detail.payment).toBeNull();
    expect(detail.openingBalance).toMatchObject({ entries: [{ amountMinor: 250000, entryDate: "2026-07-01" }], documents: [{ originalName: "Dekont MEDU9000001.pdf" }], missingEvidence: 0 });
    expect(detail.ledger.map((l) => l.type)).toEqual(["OPENING_BALANCE"]);
    expect(detail.timeline[0]).toMatchObject({ action: "openingBalance.create", reason: "Excel satır 14" });
  });

  it("continue the request chain: the next follow-up is due after the interval, as attempt 3, with the original receipt", () => {
    const blId = created(db, admin, input(), NOW);
    uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    // Mon 12 Oct + 5 business days = Mon 19 Oct.
    expect(listDueRequests(db, ops, NOW).DUE[0].rows).toEqual([expect.objectContaining({ blId, kind: "FOLLOW_UP", attemptNo: 3, dueDate: "2026-10-19", evidenceMissing: false })]);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [blId] }, NOW);
    // Nothing to reply to and no portal reference: the first-request subject.
    expect(draft).toMatchObject({ thread: null, subject: "Depozito İade Talebi – MEDU9000001", missingEvidence: [] });
    expect(draft.body).toContain("3. kez yazıyoruz");
    expect(draft.attachments.map((a) => [a.kind, a.originalName])).toEqual([
      ["FORM", "İade formu MEDU9000001.pdf"],
      ["RECEIPT", "Dekont MEDU9000001.pdf"],
      ["STANDING", "İmza sirküleri.pdf"],
      ["STANDING", "Vekaletname.pdf"],
    ]);
  });

  it("without past requests start as paid, so the first request is due; refunds are allocated to them like any B/L", () => {
    const fresh = created(db, admin, input({ pastAttempts: 0, lastRequestOn: null }), NOW);
    expect(getBlDetail(db, ops, fresh, NOW).bl.status).toBe("DUE");

    const blId = created(db, admin, input({ blNo: "MEDU9000002", customerId: testCustomer(db) }), NOW);
    const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const refund = createRefund(db, acc, { agencyId: msc, customerId: testCustomer(db), amountMinor: 250000, currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
    if (refund.status !== "created") throw new Error("refund");
    expect(allocationProposal(db, ops, refund.id).candidates).toEqual([expect.objectContaining({ blId, firstRequestOn: "2026-10-12", expectedMinor: 250000 })]);
  });

  it("need a receipt of the right kind when one is given and consistent request dates", () => {
    expect(openingBalanceSchema.safeParse({ ...input(), lastRequestOn: null }).success).toBe(false);
    expect(() => created(db, admin, input({ documentId: receipt(admin, "INVOICE") }), NOW)).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    expect(() => created(db, admin, input({ documentId: receipt(ops) }), NOW)).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    expect(() => created(db, admin, input({ lastRequestOn: "2026-06-30" }), NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.beforePayment" }));
    expect(() => created(db, admin, input({ lastRequestOn: "2026-10-23" }), NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.futureDate" }));
  });

  it("wait for the first-request delay after a recent payment, like any B/L", () => {
    // Paid Tue 20 Oct; the first request is due 10 business days later (seed), not at once.
    const blId = created(db, admin, input({ paidAt: "2026-10-20", pastAttempts: 0, lastRequestOn: null }), NOW);
    expect(getBlDetail(db, ops, blId, NOW).bl.status).toBe("PAID");
    const due = listDueRequests(db, ops, NOW);
    expect(due.DUE.flatMap((g) => g.rows).some((r) => r.blId === blId)).toBe(false);
  });

  it("can be saved without the receipt, which is attached later once (admin or operations)", () => {
    const blId = created(db, admin, input({ documentId: null }), NOW);
    expect(getBlDetail(db, ops, blId, NOW).openingBalance).toMatchObject({ documents: [], missingEvidence: 1 });
    uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    expect(prepareRequestEmails(db, ops, { blIds: [blId] }, NOW)[0].missingEvidence).toEqual(["MEDU9000001"]);

    expect(() => attachOpeningBalanceEvidence(db, acc, { blId, documentId: receipt(acc) }, NOW)).toThrow(ForbiddenError);
    attachOpeningBalanceEvidence(db, ops, { blId, documentId: receipt(ops) }, NOW);
    expect(getBlDetail(db, ops, blId, NOW).openingBalance).toMatchObject({ documents: [{ originalName: "Dekont MEDU9000001.pdf" }], missingEvidence: 0 });
    expect(db.select().from(auditLog).all().some((a) => a.action === "openingBalance.attachEvidence" && a.roleUsed === "OPERATIONS")).toBe(true);
    expect(() => attachOpeningBalanceEvidence(db, admin, { blId, documentId: receipt() }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.evidenceExists" }),
    );
  });

  it("name a customer: an existing one by name, or a new one registered with the record", () => {
    const first = created(db, admin, input({ documentId: null, customerId: null, newCustomerName: " Örnek İthalat " }), NOW);
    const registered = db.select().from(customers).where(eq(customers.name, "Örnek İthalat")).all();
    expect(registered).toMatchObject([{ name: "Örnek İthalat", aliases: [], active: true }]);
    const customerOf = (id: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get()!.customerId;
    expect(customerOf(first)).toBe(registered[0].id);
    expect(db.select().from(auditLog).all().find((a) => a.action === "customer.create")).toMatchObject({ roleUsed: "ADMIN" });

    // The next record carries the same name over: no second customer.
    const second = created(db, admin, input({ blNo: "MEDU9000002", documentId: null, customerId: null, newCustomerName: "örnek ithalat" }), NOW);
    expect(db.select().from(customers).all()).toHaveLength(2); // the test customer and this one
    expect(customerOf(second)).toBe(registered[0].id);
    expect(openingBalanceSchema.safeParse({ ...input(), customerId: registered[0].id, newCustomerName: "Başka" }).success).toBe(false);
  });

  it("name an agency not in the system yet: added by name under the admin role, reused by the next record", () => {
    const agencyOf = (id: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, id)).get()!.agencyId;
    const first = created(db, admin, input({ agencyId: null, newAgencyName: " Yeni Hat Lojistik ", documentId: null }), NOW);
    const added = db.select().from(agencies).all().find((a) => a.name === "Yeni Hat Lojistik")!;
    expect(agencyOf(first)).toBe(added.id);
    expect(db.select().from(auditLog).all().find((a) => a.action === "agency.create" && a.entityId === String(added.id))).toMatchObject({ roleUsed: "ADMIN" });

    const second = created(db, admin, input({ agencyId: null, newAgencyName: "yeni hat lojistik", blNo: "MEDU9000002", documentId: null }), NOW);
    expect(agencyOf(second)).toBe(added.id);
    expect(db.select().from(agencies).all()).toHaveLength(2);

    // A rejected record adds no agency; exactly one of an agency or a new name.
    expect(() => created(db, admin, input({ agencyId: null, newAgencyName: "Başka Hat", blNo: "MEDU9000002", documentId: null }), NOW)).toThrow();
    expect(db.select().from(agencies).all()).toHaveLength(2);
    expect(openingBalanceSchema.safeParse({ ...input(), newAgencyName: "Başka" }).success).toBe(false);
    expect(openingBalanceSchema.safeParse({ ...input(), agencyId: null }).success).toBe(false);
  });

  it("warn about a deposit with the same agency, amount and date, payment or opening balance, until confirmed", () => {
    created(db, admin, input(), NOW);
    const again = createOpeningBalance(db, admin, input({ blNo: "MEDU9000002", confirmDuplicate: false }), NOW);
    expect(again).toMatchObject({ status: "duplicate", duplicates: [{ blNo: "MEDU9000001", agencyName: "MSC", amountMinor: 250000, paidAt: "2026-07-01" }] });
    expect(db.select().from(billsOfLading).all()).toHaveLength(1);

    // A payment with the same agency, amount and date warns too.
    const paid = createPayment(db, acc, { agencyId: msc, amountMinor: 250000, currency: "USD", paidAt: "2026-07-01", kind: "BANK", blNoHint: null, evidenceDocumentId: null, queueItemId: null, confirmDuplicate: false }, NOW);
    expect(paid).toMatchObject({ status: "duplicate", duplicates: [{ blNo: "MEDU9000001" }] });
    expect(created(db, admin, input({ blNo: "MEDU9000002" }), NOW)).toBeGreaterThan(0);
  });

  describe("with the number of an active B/L", () => {
    const later = (overrides: Partial<OpeningBalanceInput> = {}) =>
      input({ amountMinor: 50000, paidAt: "2026-07-15", customerId: null, pastAttempts: 0, lastRequestOn: null, note: "Excel satır 15", ...overrides });

    it("add to that B/L as an additional deposit: own entry and receipt, the B/L's history stays", () => {
      const blId = created(db, admin, input(), NOW);
      updateBl(db, ops, { id: blId, containers: ["MSCU1234565"] }, NOW); // entered on the B/L detail
      const result = createOpeningBalance(db, admin, later({ blNo: "medu9000001" }), NOW);
      expect(result).toEqual({ status: "created", blId, joined: true });

      const detail = getBlDetail(db, ops, blId, NOW);
      expect(detail.bl).toMatchObject({ depositMinor: 300000, paidAt: "2026-07-01", attempts: 2, status: "REQUESTED", containers: ["MSCU1234565"] });
      expect(detail.openingBalance).toMatchObject({ entries: [{ amountMinor: 250000 }, { amountMinor: 50000, entryDate: "2026-07-15" }], missingEvidence: 0 });
      expect(detail.openingBalance!.documents).toHaveLength(2);
      expect(detail.ledger.map((l) => l.type)).toEqual(["OPENING_BALANCE", "OPENING_BALANCE"]);
      expect(detail.timeline[0]).toMatchObject({ action: "bl.additionalOpeningBalance", reason: "Excel satır 15" });

      // Requests attach both receipts.
      uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
      expect(prepareRequestEmails(db, ops, { blIds: [blId] }, NOW)[0].attachments.filter((a) => a.kind === "RECEIPT")).toHaveLength(2);
    });

    it("join a B/L created from a payment too, and a missing receipt is attached later, one per opening balance", () => {
      const { blId } = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU9000001", paidAt: "2026-07-01", amountMinor: 100000 }, NOW);
      created(db, admin, later({ blNo: "MEDU9000001", documentId: null }), NOW);
      const detail = getBlDetail(db, ops, blId, NOW);
      expect(detail.bl.depositMinor).toBe(150000);
      expect(detail.openingBalance).toMatchObject({ documents: [], missingEvidence: 1 });
      attachOpeningBalanceEvidence(db, ops, { blId, documentId: receipt(ops) }, NOW);
      expect(getBlDetail(db, ops, blId, NOW).openingBalance).toMatchObject({ missingEvidence: 0 });
      expect(() => attachOpeningBalanceEvidence(db, ops, { blId, documentId: receipt(ops) }, NOW)).toThrow(expect.objectContaining({ messageKey: "payments.errors.evidenceExists" }));
    });

    it("bring no request history, customer or file number, and need the same agency and currency", () => {
      created(db, admin, input(), NOW);
      for (const overrides of [{ pastAttempts: 1, lastRequestOn: "2026-10-01" }, { fileNo: "T26-00001" }, { customerId: testCustomer(db) }]) {
        expect(() => created(db, admin, later({ blNo: "MEDU9000001", ...overrides }), NOW)).toThrow(expect.objectContaining({ messageKey: "openingBalances.errors.joinFields" }));
      }
      expect(() => created(db, admin, later({ blNo: "MEDU9000001", currency: "EUR" }), NOW)).toThrow(expect.objectContaining({ messageKey: "payments.errors.additionalMismatch" }));
      const other = makeAgency(db, ops, "Hapag");
      expect(() => created(db, admin, later({ blNo: "MEDU9000001", agencyId: other }), NOW)).toThrow(expect.objectContaining({ messageKey: "payments.errors.additionalMismatch" }));
    });

    it("are previewed while typing: the B/L, its current deposit, or why the deposit cannot join", () => {
      const blId = created(db, admin, input(), NOW);
      expect(previewBlJoin(db, admin, { blNo: "medu 9000001", agencyId: msc, currency: "USD" })).toEqual({ blId, blNo: "MEDU9000001", currency: "USD", depositMinor: 250000, problem: null });
      expect(previewBlJoin(db, acc, { blNo: "MEDU9000001", agencyId: msc, currency: "EUR" })).toMatchObject({ problem: "currency" });
      expect(previewBlJoin(db, acc, { blNo: "MEDU9000001", agencyId: null, currency: "USD" })).toMatchObject({ problem: "agency" });
      expect(previewBlJoin(db, acc, { blNo: "MEDU9999999", agencyId: msc, currency: "USD" })).toBeNull();
      expect(() => previewBlJoin(db, ops, { blNo: "MEDU9000001", agencyId: msc, currency: "USD" })).toThrow(ForbiddenError);
    });
  });

  it("are prefilled from the receipt with customer and file number", () => {
    const beta = createCustomer(db, admin, { name: "Beta Gıda", code: null, aliases: ["BETA"] }, NOW);
    const prefill = prefillFromExtraction(db, { parser: "garanti", description: "BETA T26-00123 MEDU9000003 DEPOZITO", fileNumber: "T26-00123", amountMinor: 100, currency: "USD", date: "2026-10-20" });
    expect(prefill).toMatchObject({ customerId: beta, fileNo: "T26-00123", amountMinor: 100, paidAt: "2026-10-20" });
  });
});
