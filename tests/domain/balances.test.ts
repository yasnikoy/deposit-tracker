import { describe, expect, it } from "vitest";
import { blBalance, type BalanceEntry } from "@/domain/balances";

const entry = (type: BalanceEntry["type"], amountMinor: number, currency = "USD"): BalanceEntry => ({ type, amountMinor, currency });

describe("blBalance", () => {
  it("derives the deposit from payment, offset and opening-balance entries", () => {
    expect(blBalance([entry("PAYMENT", 300000)], "USD")).toEqual({
      depositMinor: 300000,
      deductionsMinor: 0,
      collectedMinor: 0,
      expectedMinor: 300000,
    });
    expect(blBalance([entry("OFFSET", 150000)], "USD").depositMinor).toBe(150000);
    expect(blBalance([entry("OPENING_BALANCE", 90000)], "USD").depositMinor).toBe(90000);
  });

  it("subtracts recorded deductions and confirmed allocations from the expected amount", () => {
    // C 1,500 USD with a 700 statement deduction expects 800.
    const balance = blBalance([entry("PAYMENT", 150000), entry("DEDUCTION", 70000)], "USD");
    expect(balance).toMatchObject({ depositMinor: 150000, deductionsMinor: 70000, expectedMinor: 80000 });

    const collected = blBalance([entry("PAYMENT", 150000), entry("DEDUCTION", 70000), entry("REFUND_ALLOCATION", 80000)], "USD");
    expect(collected).toMatchObject({ collectedMinor: 80000, expectedMinor: 0 });
  });

  it("nets compensating entries, so a corrected deposit counts once", () => {
    const balance = blBalance([entry("PAYMENT", 300000), entry("PAYMENT", -300000), entry("PAYMENT", 310000)], "USD");
    expect(balance.depositMinor).toBe(310000);
    expect(balance.expectedMinor).toBe(310000);
  });

  it("is zero for a B/L without entries", () => {
    expect(blBalance([], "EUR")).toEqual({ depositMinor: 0, deductionsMinor: 0, collectedMinor: 0, expectedMinor: 0 });
  });

  it("ignores a fully compensated pair left in the old currency by a currency correction", () => {
    const balance = blBalance([entry("PAYMENT", 300000), entry("PAYMENT", -300000), entry("PAYMENT", 300000, "EUR")], "EUR");
    expect(balance.depositMinor).toBe(300000);
  });

  it("refuses an uncompensated entry in another currency instead of mixing currencies", () => {
    expect(() => blBalance([entry("PAYMENT", 300000), entry("REFUND_ALLOCATION", 100, "EUR")], "USD")).toThrow(/currencies are never mixed/);
  });
});
