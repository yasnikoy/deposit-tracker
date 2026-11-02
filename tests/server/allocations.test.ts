import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation, reverseAllocation } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { billsOfLading, deductionTypes } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { recordStatementDeductions } from "@/server/deductions";
import { createRefundSchema } from "@/lib/schemas/refunds";
import { attachRefundEvidence, correctRefund, createRefund, getRefund, listRefunds, listRefundsToAllocate, voidRefund } from "@/server/refunds";

import { createCustomer, updateCustomer } from "@/server/customers";
import { saveCustomerFilter } from "@/server/preferences";
import { createTestDb, makeUser } from "../support/db";
import { PDF, makeAgency, makeBl, markRequested, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const usd = (amount: number) => amount * 100;

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let line: number;

/** A B/L paid long ago whose first request was recorded (on the portal) on `requestedOn`. */
function requestedBl(agencyId: number, blNo: string, amount: number, requestedOn: string, currency = "USD"): number {
  const { blId } = makeBl(db, { acc, ops }, { agencyId, blNo, paidAt: "2026-08-03", amountMinor: usd(amount), currency }, NOW);
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
  markRequested(db, ops, { blId, requestedOn }, NOW);
  return blId;
}

function refund(agencyId: number, amount: number, valueDate = "2026-10-21", currency = "USD"): number {
  const evidence = storeUpload(db, acc, { originalName: "iade-dekont.pdf", content: PDF, kind: "RECEIPT" }, NOW);
  const result = createRefund(
    db,
    acc,
    { agencyId, customerId: testCustomer(db), amountMinor: usd(amount), currency, valueDate, kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true },
    NOW,
  );
  if (result.status !== "created") throw new Error("refund not created");
  return result.id;
}

const typeId = (code: string | null, name?: string) =>
  db
    .select()
    .from(deductionTypes)
    .all()
    .find((t) => t.code === code && (!name || t.name === name))!.id;
const status = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.status;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
});

describe("refunds", () => {
  it("are entered by the accountant with a receipt; the duplicate warning asks for confirmation", () => {
    const evidence = storeUpload(db, acc, { originalName: "d.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const input = { agencyId: line, customerId: testCustomer(db), amountMinor: usd(100), currency: "USD", valueDate: "2026-10-21", kind: "BANK" as const, evidenceDocumentId: evidence.id, confirmDuplicate: false };
    expect(() => createRefund(db, ops, input, NOW)).toThrow(ForbiddenError);
    expect(createRefund(db, acc, input, NOW).status).toBe("created");
    const again = storeUpload(db, acc, { originalName: "d2.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    expect(createRefund(db, acc, { ...input, evidenceDocumentId: again.id }, NOW)).toMatchObject({ status: "duplicate" });
    expect(() => createRefund(db, acc, { ...input, valueDate: "2026-10-23", evidenceDocumentId: again.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.futureDate" }),
    );
    expect(listRefunds(db, acc)).toEqual([expect.objectContaining({ status: "OPEN", remainderMinor: usd(100) })]);
  });

  it("can be saved without a receipt, which only its accountant attaches later, once", async () => {
    const input = { agencyId: line, customerId: testCustomer(db), amountMinor: usd(250), currency: "USD", valueDate: "2026-10-21", kind: "BANK" as const, evidenceDocumentId: null, confirmDuplicate: false };
    expect(createRefundSchema.safeParse(input).success).toBe(true);
    const created = createRefund(db, acc, input, NOW);
    if (created.status !== "created") throw new Error("refund not created");
    expect(getRefund(db, created.id).evidenceDocumentId).toBeNull();

    const other = await makeUser(db, "acc2", ["ACCOUNTANT"]);
    const foreign = storeUpload(db, other, { originalName: "x.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    expect(() => attachRefundEvidence(db, other, { refundId: created.id, documentId: foreign.id }, NOW)).toThrow(ForbiddenError);

    const receipt = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    attachRefundEvidence(db, acc, { refundId: created.id, documentId: receipt.id }, NOW);
    expect(getRefund(db, created.id).evidenceDocumentId).toBe(receipt.id);
    const second = storeUpload(db, acc, { originalName: "iade2.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    expect(() => attachRefundEvidence(db, acc, { refundId: created.id, documentId: second.id }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "refunds.errors.evidenceExists" }),
    );
  });
});

describe("allocating a batched refund", () => {
  let a: number, b: number, c: number;
  beforeEach(() => {
    a = requestedBl(line, "HATU1000001", 3000, "2026-09-01");
    b = requestedBl(line, "HATU1000002", 2500, "2026-09-05");
    c = requestedBl(line, "HATU1000003", 1500, "2026-09-10");
  });

  it("A 3,000 + B 2,500 + C 1,500, refund 6,300: FIFO with the 700 difference on C as a classified deduction closes all three", () => {
    const r = refund(line, 6300);
    const proposal = allocationProposal(db, ops, r);
    expect(proposal.candidates.map((x) => x.blNo)).toEqual(["HATU1000001", "HATU1000002", "HATU1000003"]);
    expect(proposal.suggestions.exact).toEqual([]);
    expect(proposal.suggestions.fifo.shortfall).toEqual({ blId: c, amountMinor: usd(700) });

    const input = {
      refundId: r,
      lines: proposal.suggestions.fifo.lines,
      shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: typeId(null, "Demuraj / detention") },
      remainderReason: null,
    };
    expect(() => confirmAllocation(db, acc, input, NOW)).toThrow(ForbiddenError);
    confirmAllocation(db, ops, input, NOW);
    expect([status(a), status(b), status(c)]).toEqual(["COLLECTED", "COLLECTED", "ACCOUNTING_PENDING"]);
    expect(getBlDetail(db, ops, c, NOW).bl).toMatchObject({ depositMinor: usd(1500), collectedMinor: usd(800), deductionsMinor: usd(700), expectedMinor: 0 });
    expect(getRefund(db, r)).toMatchObject({ status: "ALLOCATED", remainderMinor: 0 });
    expect(listRefundsToAllocate(db, ops)).toEqual([]);

    // Frozen money records (rules 13, 15): no correction or void after a confirmed allocation.
    expect(() => correctRefund(db, acc, { id: r, agencyId: line, customerId: testCustomer(db), amountMinor: usd(6000), currency: "USD", valueDate: "2026-10-21", reason: "x" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "refunds.errors.allocated" }),
    );
    expect(() => voidRefund(db, acc, { id: r, reason: "x" }, NOW)).toThrow(expect.objectContaining({ messageKey: "refunds.errors.allocated" }));
    expect(() => voidBl(db, ops, { id: a, reason: "x" }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.allocated" }));
  });

  it("an unexplained shortfall opens a deduction on that B/L", () => {
    const r = refund(line, 6300);
    const { fifo } = allocationProposal(db, ops, r).suggestions;
    confirmAllocation(db, ops, { refundId: r, lines: fifo.lines, shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: typeId("UNEXPLAINED") }, remainderReason: null }, NOW);
    expect([status(a), status(b), status(c)]).toEqual(["COLLECTED", "COLLECTED", "DEDUCTION_OPEN"]);
  });

  it("with a 700 statement deduction on C beforehand, the exact subset A + B + C matches", () => {
    const doc = storeUpload(db, ops, { originalName: "dokum.pdf", content: PDF, kind: "DEDUCTION_STATEMENT" }, NOW).id;
    recordStatementDeductions(db, ops, { blId: c, documentId: doc, lines: [{ deductionTypeId: typeId(null, "Diğer"), amountMinor: usd(700) }] }, NOW);
    const r = refund(line, 6300);
    const { exact } = allocationProposal(db, ops, r).suggestions;
    expect(exact).toEqual([
      [
        { blId: a, amountMinor: usd(3000) },
        { blId: b, amountMinor: usd(2500) },
        { blId: c, amountMinor: usd(800) },
      ],
    ]);
    confirmAllocation(db, ops, { refundId: r, lines: exact[0], shortfall: null, remainderReason: null }, NOW);
    expect(status(c)).toBe("ACCOUNTING_PENDING");
  });

  it("an overpayment leaves the remainder on the refund, only with a reason", () => {
    const r = refund(line, 7500);
    const { fifo } = allocationProposal(db, ops, r).suggestions;
    expect(fifo.remainderMinor).toBe(usd(500));
    expect(() => confirmAllocation(db, ops, { refundId: r, lines: fifo.lines, shortfall: null, remainderReason: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "allocations.errors.remainderReason" }),
    );
    confirmAllocation(db, ops, { refundId: r, lines: fifo.lines, shortfall: null, remainderReason: "Fazla ödeme, acenteye soruldu" }, NOW);
    expect(getRefund(db, r)).toMatchObject({ status: "REMAINDER_LEFT", remainderMinor: usd(500), allocatedMinor: usd(7000) });
  });

  it("refuses a partial B/L, more than the refund, a write-off as shortfall, and B/Ls that are not candidates", () => {
    const r = refund(line, 6300);
    expect(() => confirmAllocation(db, ops, { refundId: r, lines: [{ blId: a, amountMinor: usd(2000) }], shortfall: null, remainderReason: "x" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "allocations.errors.mustSettle" }),
    );
    expect(() =>
      confirmAllocation(db, ops, { refundId: r, lines: [{ blId: a, amountMinor: usd(3000) }, { blId: b, amountMinor: usd(2500) }, { blId: c, amountMinor: usd(1500) }], shortfall: null, remainderReason: null }, NOW),
    ).toThrow(expect.objectContaining({ messageKey: "allocations.errors.exceedsRefund" }));
    expect(() =>
      confirmAllocation(db, ops, { refundId: r, lines: [{ blId: c, amountMinor: usd(800) }], shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: typeId("WRITE_OFF") }, remainderReason: "x" }, NOW),
    ).toThrow(expect.objectContaining({ messageKey: "allocations.errors.writeOff" }));

    const other = makeAgency(db, ops, "Başka Hat", { requestChannel: "PORTAL", portalUrl: "https://b.example" });
    const foreign = requestedBl(other, "BSKU1000001", 1000, "2026-09-01");
    const eur = requestedBl(line, "HATU1000004", 1000, "2026-09-01", "EUR");
    const late = requestedBl(line, "HATU1000005", 1000, "2026-10-22");
    const voided = requestedBl(line, "HATU1000006", 1000, "2026-09-01");
    voidBl(db, ops, { id: voided, reason: "Yanlış" }, NOW);
    const candidates = allocationProposal(db, ops, r).candidates.map((x) => x.blId);
    for (const id of [foreign, eur, late, voided]) expect(candidates).not.toContain(id);
    expect(() => confirmAllocation(db, ops, { refundId: r, lines: [{ blId: foreign, amountMinor: usd(1000) }], shortfall: null, remainderReason: "x" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "allocations.errors.notCandidate" }),
    );
  });

  it("a voided refund is never allocated", () => {
    const r = refund(line, 3000);
    voidRefund(db, acc, { id: r, reason: "Mükerrer" }, NOW);
    expect(() => allocationProposal(db, ops, r)).toThrow(expect.objectContaining({ messageKey: "refunds.errors.voided" }));
    expect(listRefundsToAllocate(db, ops)).toEqual([]);
  });

  it("an admin reverses a confirmed allocation with a reason; the B/L and the refund reopen", () => {
    const r = refund(line, 6300);
    const { fifo } = allocationProposal(db, ops, r).suggestions;
    const [, , onC] = confirmAllocation(
      db,
      ops,
      { refundId: r, lines: fifo.lines, shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: typeId("UNEXPLAINED") }, remainderReason: null },
      NOW,
    );
    expect(() => reverseAllocation(db, ops, { allocationId: onC, reason: "Yanlış B/L" }, NOW)).toThrow(ForbiddenError);
    reverseAllocation(db, admin, { allocationId: onC, reason: "Yanlış B/L" }, NOW);
    expect(status(c)).toBe("REQUESTED");
    // Both the allocation and its shortfall deduction are compensated.
    expect(getBlDetail(db, ops, c, NOW).bl).toMatchObject({ collectedMinor: 0, deductionsMinor: 0, expectedMinor: usd(1500) });
    expect(getRefund(db, r)).toMatchObject({ status: "PARTIALLY_ALLOCATED", remainderMinor: usd(800) });
    expect(() => reverseAllocation(db, admin, { allocationId: onC, reason: "tekrar" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "allocations.errors.alreadyReversed" }),
    );
    expect(getBlDetail(db, ops, c, NOW).timeline.map((e) => e.action)).toEqual(expect.arrayContaining(["allocation.confirm", "allocation.reverse"]));
  });
});

describe("refunds by customer", () => {
  const otherCustomer = () => createCustomer(db, admin, { name: "Beta", code: null, aliases: ["BETA"] }, NOW);
  const setCustomer = (blId: number, customerId: number | null) => db.update(billsOfLading).set({ customerId }).where(eq(billsOfLading.id, blId)).run();

  it("need exactly one active customer; a correction may change it", () => {
    const evidence = storeUpload(db, acc, { originalName: "d.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const input = { agencyId: line, customerId: null, amountMinor: usd(100), currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id };
    expect(createRefundSchema.safeParse(input).error?.issues[0].message).toBe("refunds.errors.customer");
    const beta = otherCustomer();
    updateCustomer(db, admin, { id: beta, customer: { name: "Beta", code: null, aliases: ["BETA"], active: false } }, NOW);
    expect(() => createRefund(db, acc, { ...createRefundSchema.parse({ ...input, customerId: beta }), confirmDuplicate: true }, NOW)).toThrow(/customers.errors.unknown/);

    const r = refund(line, 100);
    expect(getRefund(db, r)).toMatchObject({ customerId: testCustomer(db), customerName: "Test Müşteri" });
    const gamma = createCustomer(db, admin, { name: "Gamma", code: null, aliases: [] }, NOW);
    correctRefund(db, acc, { id: r, agencyId: line, customerId: gamma, amountMinor: usd(100), currency: "USD", valueDate: "2026-10-21", reason: "yanlış müşteri" }, NOW);
    expect(getRefund(db, r).customerId).toBe(gamma);
  });

  it("are suggested only the refund customer's B/Ls; others, and B/Ls without a customer, can still be added by hand", () => {
    const a = requestedBl(line, "HAT0000001", 3000, "2026-09-01");
    const b = requestedBl(line, "HAT0000002", 2500, "2026-09-02");
    const c = requestedBl(line, "HAT0000003", 1500, "2026-09-03");
    setCustomer(b, otherCustomer());
    setCustomer(c, null);
    const r = refund(line, 3000);
    const proposal = allocationProposal(db, ops, r);
    expect(proposal.candidates.map((x) => x.blId)).toEqual([a]);
    expect(proposal.otherCandidates.map((x) => [x.blId, x.customerName])).toEqual([
      [b, "Beta"],
      [c, null],
    ]);
    expect(proposal.suggestions.exact).toEqual([[{ blId: a, amountMinor: usd(3000) }]]);

    // Chosen by hand from another customer: still allowed, nothing is ever auto-confirmed.
    const r2 = refund(line, 2500, "2026-10-21");
    confirmAllocation(db, ops, { refundId: r2, lines: [{ blId: b, amountMinor: usd(2500) }], shortfall: null, remainderReason: null }, NOW);
    expect(status(b)).toBe("COLLECTED");
  });

  it("to allocate follow the viewer's customer filter; refunds of other customers drop out", () => {
    const beta = otherCustomer();
    const mine = refund(line, 100);
    const evidence = storeUpload(db, acc, { originalName: "b.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const theirs = createRefund(db, acc, { agencyId: line, customerId: beta, amountMinor: usd(200), currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
    if (theirs.status !== "created") throw new Error("refund");
    expect(listRefundsToAllocate(db, ops).map((x) => x.id)).toEqual([mine, theirs.id]);
    saveCustomerFilter(db, ops, [testCustomer(db)], NOW);
    expect(listRefundsToAllocate(db, ops).map((x) => x.id)).toEqual([mine]);
  });
});
