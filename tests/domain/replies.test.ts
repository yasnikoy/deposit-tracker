import { describe, expect, it } from "vitest";
import { countsAsAnswer } from "@/domain/replies";

describe("follow-up clock", () => {
  it("restarts on every reply except an info-only one", () => {
    expect(countsAsAnswer("NOT_RETURNED")).toBe(true);
    expect(countsAsAnswer(null)).toBe(true);
    expect(countsAsAnswer("INFO")).toBe(false);
  });
});
