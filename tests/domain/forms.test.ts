import { describe, expect, it } from "vitest";
import { FORM_PLACEHOLDERS, pickFormBankAccount, unknownPlaceholders } from "@/domain/forms";

const account = (id: number, currency: string, active = true) => ({ id, currency, active, bankName: `Banka ${id}`, iban: `TR${id}` });

describe("pickFormBankAccount", () => {
  it("uses the single active account in the B/L currency", () => {
    const result = pickFormBankAccount([account(1, "USD"), account(2, "EUR"), account(3, "USD", false)], "USD");
    expect(result).toEqual({ account: account(1, "USD"), warning: null });
  });

  it("leaves the fields blank with a warning when there is no active account in that currency", () => {
    expect(pickFormBankAccount([account(1, "EUR"), account(2, "USD", false)], "USD")).toEqual({ account: null, warning: "none" });
  });

  it("leaves the fields blank with a warning when several active accounts match", () => {
    expect(pickFormBankAccount([account(1, "USD"), account(2, "USD")], "USD")).toEqual({ account: null, warning: "several" });
  });
});

describe("unknownPlaceholders", () => {
  it("accepts the documented placeholders", () => {
    expect(FORM_PLACEHOLDERS).toEqual([
      "agency_name",
      "bl_no",
      "containers",
      "container_count",
      "amount",
      "currency",
      "paid_at",
      "bank_name",
      "iban",
      "today",
    ]);
    expect(unknownPlaceholders(["bl_no", "iban", "bl_no"])).toEqual([]);
  });

  it("reports unknown ones once each, in order", () => {
    expect(unknownPlaceholders(["bl_no", "imza", "BL_NO", "imza"])).toEqual(["imza", "BL_NO"]);
  });
});
