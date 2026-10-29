import { describe, expect, it } from "vitest";
import { InvalidTransitionError, nextStatus, statusAfterReversal } from "@/domain/bl-lifecycle";

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

describe("confirmed allocation", () => {
  it("closes a requested or awaiting-return B/L when allocations and classified deductions cover it", () => {
    expect(nextStatus("REQUESTED", "ALLOCATION_SETTLED")).toBe("COLLECTED");
    expect(nextStatus("AWAITING_RETURN", "ALLOCATION_SETTLED")).toBe("COLLECTED");
  });

  it("opens a deduction when the shortfall is marked unexplained", () => {
    expect(nextStatus("REQUESTED", "ALLOCATION_UNEXPLAINED")).toBe("DEDUCTION_OPEN");
    expect(nextStatus("AWAITING_RETURN", "ALLOCATION_UNEXPLAINED")).toBe("DEDUCTION_OPEN");
  });

  it("is rejected before any request and on a collected B/L", () => {
    for (const event of ["ALLOCATION_SETTLED", "ALLOCATION_UNEXPLAINED"] as const) {
      expect(() => nextStatus("PAID", event)).toThrow(InvalidTransitionError);
      expect(() => nextStatus("COLLECTED", event)).toThrow(InvalidTransitionError);
    }
  });
});

describe("allocation reversal (admin)", () => {
  it("returns the B/L to its status before the allocation", () => {
    expect(statusAfterReversal("COLLECTED", "REQUESTED")).toBe("REQUESTED");
    expect(statusAfterReversal("DEDUCTION_OPEN", "AWAITING_RETURN")).toBe("AWAITING_RETURN");
    expect(statusAfterReversal("DISPUTED", "REQUESTED")).toBe("REQUESTED");
  });

  it("only applies to statuses an allocation leads to, back to a status that takes allocations", () => {
    expect(() => statusAfterReversal("REQUESTED", "REQUESTED")).toThrow(InvalidTransitionError);
    expect(() => statusAfterReversal("COLLECTED", "PAID")).toThrow(InvalidTransitionError);
  });
});
