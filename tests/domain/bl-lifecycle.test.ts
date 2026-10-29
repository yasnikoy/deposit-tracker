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

describe("reply type 'container not yet returned' recorded", () => {
  it("moves a requested B/L to awaiting return and keeps it there", () => {
    expect(nextStatus("REQUESTED", "NOT_RETURNED_REPLY")).toBe("AWAITING_RETURN");
    expect(nextStatus("AWAITING_RETURN", "NOT_RETURNED_REPLY")).toBe("AWAITING_RETURN");
  });

  it("is rejected before any request and after collection", () => {
    for (const from of ["PAID", "COLLECTED", "DEDUCTION_OPEN", "DISPUTED"] as const) {
      expect(() => nextStatus(from, "NOT_RETURNED_REPLY")).toThrow(InvalidTransitionError);
    }
  });
});
