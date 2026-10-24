import { describe, expect, it } from "vitest";
import { InvalidTransitionError, nextStatus } from "@/domain/bl-lifecycle";

describe("refund request sent (email sent or portal request recorded)", () => {
  it("moves a paid B/L to REQUESTED and brings an awaiting-return B/L back to REQUESTED", () => {
    expect(nextStatus("PAID", "REFUND_REQUEST_SENT")).toBe("REQUESTED");
    expect(nextStatus("AWAITING_RETURN", "REFUND_REQUEST_SENT")).toBe("REQUESTED");
  });

  it("keeps a REQUESTED B/L requested (follow-up without a reply)", () => {
    expect(nextStatus("REQUESTED", "REFUND_REQUEST_SENT")).toBe("REQUESTED");
  });

  it("is rejected for statuses that no longer take refund requests", () => {
    for (const status of ["DEDUCTION_OPEN", "DISPUTED", "COLLECTED"] as const) {
      expect(() => nextStatus(status, "REFUND_REQUEST_SENT")).toThrow(InvalidTransitionError);
    }
  });
});
