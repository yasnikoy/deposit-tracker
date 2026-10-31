import { describe, expect, it } from "vitest";
import { agingBuckets, agingReport, agencyScorecard, bucketIndex, type ScorecardBl } from "@/domain/reports";

describe("aging buckets", () => {
  it("follow the bucket-edge setting: 0–20, 21–40, 41–60, 61+", () => {
    expect(agingBuckets([20, 40, 60])).toEqual([
      { from: 0, to: 20 },
      { from: 21, to: 40 },
      { from: 41, to: 60 },
      { from: 61, to: null },
    ]);
    expect([0, 20, 21, 40, 60, 61, 400].map((days) => bucketIndex(days, [20, 40, 60]))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });

  it("sum the outstanding amount and count per agency and currency, never across currencies", () => {
    const rows = agingReport(
      [
        { agencyId: 2, agencyName: "Maersk", currency: "USD", outstandingMinor: 100000, daysWaiting: 5 },
        { agencyId: 1, agencyName: "CMA CGM", currency: "EUR", outstandingMinor: 50000, daysWaiting: 70 },
        { agencyId: 2, agencyName: "Maersk", currency: "USD", outstandingMinor: 30000, daysWaiting: 25 },
        { agencyId: 2, agencyName: "Maersk", currency: "EUR", outstandingMinor: 20000, daysWaiting: 25 },
        { agencyId: 2, agencyName: "Maersk", currency: "USD", outstandingMinor: 70000, daysWaiting: 20 },
      ],
      [20, 40, 60],
    );
    expect(rows.map((r) => [r.agencyName, r.currency])).toEqual([
      ["CMA CGM", "EUR"],
      ["Maersk", "EUR"],
      ["Maersk", "USD"],
    ]);
    expect(rows[2]).toMatchObject({
      buckets: [
        { count: 2, amountMinor: 170000 },
        { count: 1, amountMinor: 30000 },
        { count: 0, amountMinor: 0 },
        { count: 0, amountMinor: 0 },
      ],
      total: { count: 3, amountMinor: 200000 },
    });
    expect(rows[0].buckets[3]).toEqual({ count: 1, amountMinor: 50000 });
  });
});

describe("agency scorecard", () => {
  const bl = (overrides: Partial<ScorecardBl>): ScorecardBl => ({
    agencyId: 1,
    agencyName: "MSC",
    currency: "USD",
    depositMinor: 100000,
    outstandingMinor: 0,
    open: false,
    daysToRefund: null,
    attempts: 1,
    deductions: [],
    ...overrides,
  });

  it("averages days to refund and attempts over B/Ls collected through a refund", () => {
    const [row] = agencyScorecard([
      bl({ daysToRefund: 10, attempts: 1 }),
      bl({ daysToRefund: 31, attempts: 4 }),
      // Closed by a write-off: no refund, so it does not count for the averages.
      bl({ daysToRefund: null, attempts: 2, deductions: [{ typeName: "Silinen", amountMinor: 100000, writeOff: true }] }),
      bl({ open: true, outstandingMinor: 250000, depositMinor: 250000, attempts: 3 }),
    ]);
    expect(row).toMatchObject({ refundedCount: 2, avgDaysToRefund: 20.5, avgAttempts: 2.5, openCount: 1, openBalanceMinor: 250000 });
  });

  it("gives deduction rates by type against the deposits of closed B/Ls, write-offs separate", () => {
    const [row] = agencyScorecard([
      bl({ daysToRefund: 10, deductions: [{ typeName: "Demuraj / detention", amountMinor: 10000, writeOff: false }] }),
      bl({ daysToRefund: 12, deductions: [{ typeName: "Demuraj / detention", amountMinor: 5000, writeOff: false }, { typeName: "Diğer", amountMinor: 2000, writeOff: false }] }),
      bl({ deductions: [{ typeName: "Silinen", amountMinor: 40000, writeOff: true }] }),
      bl({ daysToRefund: 9 }),
    ]);
    // Closed deposits: 4 × 1,000.00 = 4,000.00.
    expect(row.deductions).toEqual([
      { typeName: "Demuraj / detention", amountMinor: 15000, rate: 0.0375 },
      { typeName: "Diğer", amountMinor: 2000, rate: 0.005 },
    ]);
    expect(row.writeOff).toEqual({ amountMinor: 40000, rate: 0.1 });
  });

  it("has no averages or rates without closed B/Ls", () => {
    const [row] = agencyScorecard([bl({ open: true, outstandingMinor: 100000 })]);
    expect(row).toMatchObject({ refundedCount: 0, avgDaysToRefund: null, avgAttempts: null, deductions: [], writeOff: { amountMinor: 0, rate: null } });
  });
});
