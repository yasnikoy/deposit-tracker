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

describe("statement deductions that take the whole deposit", () => {
  it("close a requested or awaiting-return B/L without a refund", () => {
    expect(nextStatus("REQUESTED", "STATEMENT_SETTLED")).toBe("COLLECTED");
    expect(nextStatus("AWAITING_RETURN", "STATEMENT_SETTLED")).toBe("COLLECTED");
    for (const from of ["PAID", "DEDUCTION_OPEN", "DISPUTED", "COLLECTED"] as const) {
      expect(() => nextStatus(from, "STATEMENT_SETTLED")).toThrow(InvalidTransitionError);
    }
  });
});

describe("unexplained deduction", () => {
  it("is disputed only while the deduction is open", () => {
    expect(nextStatus("DEDUCTION_OPEN", "DEDUCTION_DISPUTED")).toBe("DISPUTED");
    for (const from of ["REQUESTED", "AWAITING_RETURN", "DISPUTED", "COLLECTED"] as const) {
      expect(() => nextStatus(from, "DEDUCTION_DISPUTED")).toThrow(InvalidTransitionError);
    }
  });

  it("closes the B/L once classified with a real type, also when a dispute is cleared", () => {
    expect(nextStatus("DEDUCTION_OPEN", "DEDUCTION_CLASSIFIED")).toBe("COLLECTED");
    expect(nextStatus("DISPUTED", "DEDUCTION_CLASSIFIED")).toBe("COLLECTED");
    for (const from of ["REQUESTED", "AWAITING_RETURN", "COLLECTED"] as const) {
      expect(() => nextStatus(from, "DEDUCTION_CLASSIFIED")).toThrow(InvalidTransitionError);
    }
  });

  it("closes a disputed B/L when the agency pays the difference", () => {
    expect(nextStatus("DISPUTED", "DIFFERENCE_PAID")).toBe("COLLECTED");
    for (const from of ["REQUESTED", "DEDUCTION_OPEN", "COLLECTED"] as const) {
      expect(() => nextStatus(from, "DIFFERENCE_PAID")).toThrow(InvalidTransitionError);
    }
  });
});

describe("approved write-off", () => {
  it("closes any open B/L", () => {
    for (const from of ["PAID", "REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN", "DISPUTED"] as const) {
      expect(nextStatus(from, "WRITE_OFF_APPROVED")).toBe("COLLECTED");
    }
    expect(() => nextStatus("COLLECTED", "WRITE_OFF_APPROVED")).toThrow(InvalidTransitionError);
  });
});

describe("allocation reversal (admin)", () => {
  it("returns the B/L to its status before the allocation", () => {
    expect(statusAfterReversal("COLLECTED", "REQUESTED")).toBe("REQUESTED");
    expect(statusAfterReversal("DEDUCTION_OPEN", "AWAITING_RETURN")).toBe("AWAITING_RETURN");
    expect(statusAfterReversal("DISPUTED", "REQUESTED")).toBe("REQUESTED");
    // Reversing the payment of a disputed difference reopens the dispute.
    expect(statusAfterReversal("COLLECTED", "DISPUTED")).toBe("DISPUTED");
  });

  it("only applies to statuses an allocation leads to, back to a status that takes allocations", () => {
    expect(() => statusAfterReversal("REQUESTED", "REQUESTED")).toThrow(InvalidTransitionError);
    expect(() => statusAfterReversal("COLLECTED", "PAID")).toThrow(InvalidTransitionError);
  });
});
