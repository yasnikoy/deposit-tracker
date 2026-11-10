import { describe, expect, it } from "vitest";
import { isOnHold } from "@/domain/hold";

describe("on hold", () => {
  const held = { holdReasonId: 1, holdUntil: null as string | null };

  it("holds until lifted, or until its review date arrives", () => {
    expect(isOnHold({ holdReasonId: null, holdUntil: null }, "2026-11-10")).toBe(false);
    expect(isOnHold(held, "2026-11-10")).toBe(true);
    expect(isOnHold({ ...held, holdUntil: "2026-11-11" }, "2026-11-10")).toBe(true);
    // On the review date the B/L is back in the work lists.
    expect(isOnHold({ ...held, holdUntil: "2026-11-10" }, "2026-11-10")).toBe(false);
  });
});
