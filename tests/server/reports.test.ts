import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { deductionTypes } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { createRefund } from "@/server/refunds";
import { agencyScorecardFor, agingReportFor, dashboardSummary } from "@/server/reports";
import { recordPortalRequest } from "@/server/requests";
import { approveWriteOff, proposeWriteOff } from "@/server/write-offs";
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
let a: number, b: number, c: number, d: number;

function requestedBl(blNo: string, amount: number, currency = "USD"): number {
  const { blId } = makeBl(db, { acc, ops }, { agencyId: line, blNo, paidAt: "2026-08-03", amountMinor: usd(amount), currency }, NOW);
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
  recordPortalRequest(db, ops, { blId, requestedOn: "2026-09-01", portalRef: null }, NOW);
  return blId;
}

function refund(amount: number, valueDate = "2026-10-21"): number {
  const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
  const result = createRefund(db, acc, { agencyId: line, amountMinor: usd(amount), currency: "USD", valueDate, kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
  if (result.status !== "created") throw new Error("refund");
  return result.id;
}

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
  a = requestedBl("HATU1000001", 3000);
  b = requestedBl("HATU1000002", 2500);
  c = requestedBl("HATU1000003", 1500);
  d = requestedBl("HATU1000004", 1000);
  requestedBl("HATU1000005", 400, "EUR");
  // Refund 6,300 for A + B + C: C bears an unexplained 700.
  const unexplained = db.select().from(deductionTypes).where(eq(deductionTypes.code, "UNEXPLAINED")).get()!.id;
  const r = refund(6300);
  const lines = allocationProposal(db, ops, r).suggestions.fifo.lines.filter((l) => [a, b, c].includes(l.blId));
  confirmAllocation(db, ops, { refundId: r, lines, shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: unexplained }, remainderReason: null }, NOW);
});

describe("dashboard", () => {
  it("shows open balance (unexplained deductions included) and what was collected this month, per currency", () => {
    const summary = dashboardSummary(db, ops, NOW);
    expect(summary.openBalance).toEqual([
      { currency: "EUR", amountMinor: usd(400) },
      { currency: "USD", amountMinor: usd(700 + 1000) },
    ]);
    expect(summary.collectedThisMonth).toEqual([{ currency: "USD", amountMinor: usd(6300) }]);
    expect(summary.problems).toEqual({ deductionOpen: 1, disputed: 0 });
    // D and the EUR B/L are due for a follow-up; C's deduction-statement request comes Monday.
    expect(summary.todaysWork).toMatchObject({ due: 2, followUps: 2, statements: 0, upcoming: 1 });
  });

  it("counts money left unallocated on refunds, and leaves out the lists a role cannot open", () => {
    const over = refund(1500);
    confirmAllocation(db, ops, { refundId: over, lines: [{ blId: d, amountMinor: usd(1000) }], shortfall: null, remainderReason: "Fazla ödeme" }, NOW);
    expect(dashboardSummary(db, ops, NOW).pending).toMatchObject({ unallocated: { count: 1, totals: [{ currency: "USD", amountMinor: usd(500) }] }, writeOffsAwaiting: null });

    const forAccountant = dashboardSummary(db, acc, NOW);
    expect(forAccountant.pending).toMatchObject({ refundsToAllocate: null, unallocated: null, unprocessedReplies: null, paymentsWithoutBl: 0 });
    // The overpaid refund closed D; the EUR follow-up is left.
    expect(forAccountant.todaysWork.due).toBe(1);

    proposeWriteOff(db, ops, { blId: c, reason: "Takibe değmez" }, NOW);
    expect(dashboardSummary(db, admin, NOW).pending.writeOffsAwaiting).toBe(1);
  });
});

describe("reports", () => {
  it("aging buckets open deposits by business days since payment, per agency and currency", () => {
    const report = agingReportFor(db, acc, NOW);
    expect(report.buckets.map((bucket) => [bucket.from, bucket.to])).toEqual([
      [0, 20],
      [21, 40],
      [41, 60],
      [61, null],
    ]);
    // Paid Mon 3 Aug: 57 business days by Thu 22 Oct (holidays aside), so 41–60.
    expect(report.rows).toEqual([
      expect.objectContaining({ currency: "EUR", total: { count: 1, amountMinor: usd(400) } }),
      expect.objectContaining({
        agencyName: "Hat Lojistik",
        currency: "USD",
        buckets: [{ count: 0, amountMinor: 0 }, { count: 0, amountMinor: 0 }, { count: 2, amountMinor: usd(1700) }, { count: 0, amountMinor: 0 }],
        total: { count: 2, amountMinor: usd(1700) },
      }),
    ]);
  });

  it("scores the agency: days to refund and attempts of refunded B/Ls, deduction and write-off rates, open balance", () => {
    const writeOff = proposeWriteOff(db, ops, { blId: c, reason: "Takibe değmez" }, NOW);
    approveWriteOff(db, admin, { writeOffId: writeOff, note: null }, NOW);
    const usdRow = agencyScorecardFor(db, ops, NOW).find((row) => row.currency === "USD")!;
    expect(usdRow).toMatchObject({
      // A, B and C received the refund (value date Wed 21 Oct, 57 business days after payment); C's rest was written off.
      refundedCount: 3,
      avgDaysToRefund: 57,
      avgAttempts: 1,
      deductions: [],
      // 700 written off of 7,000 closed deposits.
      writeOff: { amountMinor: usd(700), rate: 0.1 },
      openCount: 1,
      openBalanceMinor: usd(1000),
    });
  });

  it("are open to every role, but only to signed-in users with a role", () => {
    expect(() => agingReportFor(db, { ...ops, roles: [] }, NOW)).toThrow(ForbiddenError);
  });
});
