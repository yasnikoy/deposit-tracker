import { describe, expect, it } from "vitest";
import { suggestAllocations, type AllocationCandidate } from "@/domain/allocation";

// ARCHITECTURE → Payments, deductions and refund reconciliation; amounts in cents.
const usd = (amount: number) => amount * 100;
const bl = (id: number, expected: number, firstRequestOn: string): AllocationCandidate => ({
  blId: id,
  expectedMinor: usd(expected),
  firstRequestOn,
});
const A = bl(1, 3000, "2026-09-01");
const B = bl(2, 2500, "2026-09-05");
const C = bl(3, 1500, "2026-09-10");

describe("allocation suggestions", () => {
  it("A 3,000 + B 2,500 + C 1,500 open, refund 6,300: no exact subset; FIFO A + B + C 800 with 700 difference", () => {
    const result = suggestAllocations({ refundMinor: usd(6300), candidates: [C, A, B], maxExact: 3 });
    expect(result.exact).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(result.fifo).toEqual({
      lines: [
        { blId: 1, amountMinor: usd(3000) },
        { blId: 2, amountMinor: usd(2500) },
        { blId: 3, amountMinor: usd(800) },
      ],
      shortfall: { blId: 3, amountMinor: usd(700) },
      remainderMinor: 0,
    });
  });

  it("with a 700 statement deduction on C (expected 800) the exact subset A + B + C matches", () => {
    const result = suggestAllocations({ refundMinor: usd(6300), candidates: [A, B, { ...C, expectedMinor: usd(800) }], maxExact: 3 });
    expect(result.exact).toEqual([
      [
        { blId: 1, amountMinor: usd(3000) },
        { blId: 2, amountMinor: usd(2500) },
        { blId: 3, amountMinor: usd(800) },
      ],
    ]);
  });

  it("several exact combinations are ranked oldest first, up to the number shown", () => {
    const candidates = [bl(1, 1000, "2026-09-01"), bl(2, 1000, "2026-09-02"), bl(3, 1000, "2026-09-03"), bl(4, 2000, "2026-09-04")];
    const result = suggestAllocations({ refundMinor: usd(2000), candidates, maxExact: 3 });
    expect(result.exact.map((combo) => combo.map((l) => l.blId))).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    expect(suggestAllocations({ refundMinor: usd(2000), candidates, maxExact: 10 }).exact.map((c) => c.map((l) => l.blId))).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
      [4],
    ]);
  });

  it("overpayment: every B/L is filled and the remainder stays unallocated on the refund", () => {
    const result = suggestAllocations({ refundMinor: usd(7500), candidates: [A, B, C], maxExact: 3 });
    expect(result.exact).toEqual([]);
    expect(result.fifo).toEqual({
      lines: [
        { blId: 1, amountMinor: usd(3000) },
        { blId: 2, amountMinor: usd(2500) },
        { blId: 3, amountMinor: usd(1500) },
      ],
      shortfall: null,
      remainderMinor: usd(500),
    });
  });

  it("a refund smaller than the oldest B/L goes to it alone, with the difference", () => {
    expect(suggestAllocations({ refundMinor: usd(2000), candidates: [A, B], maxExact: 3 }).fifo).toEqual({
      lines: [{ blId: 1, amountMinor: usd(2000) }],
      shortfall: { blId: 1, amountMinor: usd(1000) },
      remainderMinor: 0,
    });
  });

  it("no candidates: nothing to suggest, the whole refund is a remainder", () => {
    const result = suggestAllocations({ refundMinor: usd(100), candidates: [], maxExact: 3 });
    expect(result).toEqual({ exact: [], fifo: { lines: [], shortfall: null, remainderMinor: usd(100) }, incomplete: false });
  });

  it("caps the exact search at the 30 oldest candidates and flags the result incomplete", () => {
    const day = (i: number) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
    const many = Array.from({ length: 35 }, (_, i) => bl(i + 1, 1000 + i, day(i)));
    // Only B/L 35 (the newest) matches the refund exactly; it is outside the search.
    const result = suggestAllocations({ refundMinor: usd(1034), candidates: many, maxExact: 3 });
    expect(result.incomplete).toBe(true);
    expect(result.exact).toEqual([]);
  });

  it("stops at the time budget and flags the result incomplete", () => {
    const many = Array.from({ length: 30 }, (_, i) => bl(i + 1, 1000 + i * 7, "2026-09-01"));
    let ticks = 0;
    // An amount no combination reaches, so the search would walk a large tree.
    const result = suggestAllocations({ refundMinor: usd(20000) + 1, candidates: many, maxExact: 3, clock: () => (ticks += 100), budgetMs: 500 });
    expect(result.incomplete).toBe(true);
  });

  it("ignores B/Ls with nothing left to collect", () => {
    const result = suggestAllocations({ refundMinor: usd(2500), candidates: [{ ...A, expectedMinor: 0 }, B], maxExact: 3 });
    expect(result.exact).toEqual([[{ blId: 2, amountMinor: usd(2500) }]]);
  });
});
