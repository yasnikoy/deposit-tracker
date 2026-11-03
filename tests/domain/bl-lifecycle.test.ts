import { describe, expect, it } from "vitest";
import { closingStatus, InvalidTransitionError, isSettled, nextStatus, statusAfterReversal, statusAfterTransferReversal, statusAfterUndo } from "@/domain/bl-lifecycle";

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

describe("undo of an action that moved the B/L (within the undo window)", () => {
  it("returns a 'not yet returned' reply or a settling statement to the status before it", () => {
    expect(statusAfterUndo({ current: "AWAITING_RETURN", before: "REQUESTED", after: "AWAITING_RETURN" })).toBe("REQUESTED");
    expect(statusAfterUndo({ current: "COLLECTED", before: "AWAITING_RETURN", after: "COLLECTED" })).toBe("AWAITING_RETURN");
  });

  it("changes nothing when the action did not move the B/L", () => {
    expect(statusAfterUndo({ current: "AWAITING_RETURN", before: "AWAITING_RETURN", after: "AWAITING_RETURN" })).toBe("AWAITING_RETURN");
  });

  it("is rejected once the B/L moved on, and never undoes allocations, disputes or write-offs", () => {
    expect(() => statusAfterUndo({ current: "REQUESTED", before: "REQUESTED", after: "AWAITING_RETURN" })).toThrow(InvalidTransitionError);
    expect(() => statusAfterUndo({ current: "COLLECTED", before: "REQUESTED", after: "COLLECTED", })).not.toThrow();
    for (const [before, after] of [
      ["REQUESTED", "DEDUCTION_OPEN"],
      ["DEDUCTION_OPEN", "DISPUTED"],
      ["DISPUTED", "COLLECTED"],
      ["PAID", "REQUESTED"],
    ] as const) {
      expect(() => statusAfterUndo({ current: after, before, after })).toThrow(InvalidTransitionError);
    }
  });
});

describe("accounting entry for closures with deductions or offsets", () => {
  it("lands a closing B/L on ACCOUNTING_PENDING when a deduction or an offset refund was involved, else on COLLECTED", () => {
    expect(closingStatus("COLLECTED", { hasDeduction: false, hasOffsetRefund: false })).toBe("COLLECTED");
    expect(closingStatus("COLLECTED", { hasDeduction: true, hasOffsetRefund: false })).toBe("ACCOUNTING_PENDING");
    expect(closingStatus("COLLECTED", { hasDeduction: false, hasOffsetRefund: true })).toBe("ACCOUNTING_PENDING");
    // Only a closure waits; other moves are untouched.
    expect(closingStatus("DEDUCTION_OPEN", { hasDeduction: true, hasOffsetRefund: true })).toBe("DEDUCTION_OPEN");
  });

  it("closes only from ACCOUNTING_PENDING once the accountant records the entry", () => {
    expect(nextStatus("ACCOUNTING_PENDING", "ACCOUNTING_RECORDED")).toBe("COLLECTED");
    for (const from of ["PAID", "REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN", "DISPUTED", "COLLECTED"] as const) {
      expect(() => nextStatus(from, "ACCOUNTING_RECORDED")).toThrow(InvalidTransitionError);
    }
  });

  it("is settled: no requests, replies, allocations or write-offs move it", () => {
    for (const event of ["REFUND_REQUEST_SENT", "NOT_RETURNED_REPLY", "ALLOCATION_SETTLED", "STATEMENT_SETTLED", "WRITE_OFF_APPROVED", "DEDUCTION_DISPUTED"] as const) {
      expect(() => nextStatus("ACCOUNTING_PENDING", event)).toThrow(InvalidTransitionError);
    }
    expect(isSettled("ACCOUNTING_PENDING")).toBe(true);
    expect(isSettled("COLLECTED")).toBe(true);
    expect(isSettled("DISPUTED")).toBe(false);
  });

  it("a reversed allocation reopens it like a collected B/L", () => {
    expect(statusAfterReversal("ACCOUNTING_PENDING", "REQUESTED")).toBe("REQUESTED");
  });

  it("undo takes back the accountant's entry, and a settling statement that left the B/L waiting", () => {
    expect(statusAfterUndo({ current: "COLLECTED", before: "ACCOUNTING_PENDING", after: "COLLECTED" })).toBe("ACCOUNTING_PENDING");
    expect(statusAfterUndo({ current: "ACCOUNTING_PENDING", before: "REQUESTED", after: "ACCOUNTING_PENDING" })).toBe("REQUESTED");
    // Moved on since (the entry was recorded): the statement can no longer be undone this way.
    expect(() => statusAfterUndo({ current: "COLLECTED", before: "REQUESTED", after: "ACCOUNTING_PENDING" })).toThrow(InvalidTransitionError);
  });
});

describe("deposit transferred to another B/L (full transfer)", () => {
  it("settles an open B/L before any deduction or allocation, waiting for the accounting entry", () => {
    for (const from of ["PAID", "REQUESTED", "AWAITING_RETURN"] as const) expect(nextStatus(from, "DEPOSIT_TRANSFERRED")).toBe("ACCOUNTING_PENDING");
    for (const from of ["DEDUCTION_OPEN", "DISPUTED", "ACCOUNTING_PENDING", "COLLECTED", "TRANSFERRED"] as const) {
      expect(() => nextStatus(from, "DEPOSIT_TRANSFERRED")).toThrow(InvalidTransitionError);
    }
  });

  it("closes as TRANSFERRED, not COLLECTED, once the accountant records it (rule 1)", () => {
    expect(nextStatus("ACCOUNTING_PENDING", "TRANSFER_RECORDED")).toBe("TRANSFERRED");
    expect(() => nextStatus("TRANSFERRED", "ACCOUNTING_RECORDED")).toThrow(InvalidTransitionError);
    expect(isSettled("TRANSFERRED")).toBe(true);
    // The accountant's entry can be undone within the window like any accounting entry.
    expect(statusAfterUndo({ current: "TRANSFERRED", before: "ACCOUNTING_PENDING", after: "TRANSFERRED" })).toBe("ACCOUNTING_PENDING");
  });

  it("is reversed by an admin back to the status before, only while the accounting entry is not recorded", () => {
    expect(statusAfterTransferReversal("ACCOUNTING_PENDING", "AWAITING_RETURN")).toBe("AWAITING_RETURN");
    expect(() => statusAfterTransferReversal("TRANSFERRED", "REQUESTED")).toThrow(InvalidTransitionError);
    expect(() => statusAfterTransferReversal("ACCOUNTING_PENDING", "DISPUTED")).toThrow(InvalidTransitionError);
  });
});
