import { describe, expect, it } from "vitest";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";

describe("parseAmountInput (Turkish format → integer cents)", () => {
  it("reads Turkish thousands and decimal separators", () => {
    expect(parseAmountInput("3.000,50")).toBe(300050);
    expect(parseAmountInput("3000,5")).toBe(300050);
    expect(parseAmountInput("1.234.567,89")).toBe(123456789);
    expect(parseAmountInput("2.500")).toBe(250000);
    expect(parseAmountInput("700")).toBe(70000);
    expect(parseAmountInput(" 1 500,00 ")).toBe(150000);
  });

  it("accepts a dot as decimal separator when it is clearly one", () => {
    expect(parseAmountInput("3000.50")).toBe(300050);
    expect(parseAmountInput("12.5")).toBe(1250);
  });

  it("never goes through floating point", () => {
    expect(parseAmountInput("0,29")).toBe(29);
    expect(parseAmountInput("1.000.000,07")).toBe(100000007);
  });

  it("rejects empty, negative, zero, too precise and malformed input", () => {
    for (const bad of ["", "abc", "-5", "0", "0,00", "1,234", "3,000.50", "1.23.4", "1,2,3", "12,"]) {
      expect(parseAmountInput(bad), bad).toBeNull();
    }
  });
});

describe("formatting", () => {
  it("formats cents in Turkish style", () => {
    expect(formatAmount(300050)).toBe("3.000,50");
    expect(formatAmount(5)).toBe("0,05");
    expect(formatAmount(-70000)).toBe("-700,00");
    expect(formatMoney(630000, "USD")).toBe("6.300,00 USD");
  });
});
