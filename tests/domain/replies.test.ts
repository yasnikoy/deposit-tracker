import { describe, expect, it } from "vitest";
import { countsAsAnswer, findBlNumbers } from "@/domain/replies";

describe("B/L numbers in an email", () => {
  const open = ["MEDU1000001", "MAEU-77/1", "ABC123"];

  it("finds none, one or several, in list order and case-insensitively", () => {
    expect(findBlNumbers("Merhaba, ekte bilgi var.", open)).toEqual([]);
    expect(findBlNumbers("RE: medu1000001 depozito", open)).toEqual(["MEDU1000001"]);
    expect(findBlNumbers("ABC123 ve MEDU1000001 iade edildi", open)).toEqual(["MEDU1000001", "ABC123"]);
  });

  it("matches whole tokens only", () => {
    expect(findBlNumbers("MEDU10000012 ve XABC123", open)).toEqual([]);
    expect(findBlNumbers("B/L: MAEU-77/1.", open)).toEqual(["MAEU-77/1"]);
  });
});

describe("follow-up clock", () => {
  it("restarts on every reply except an info-only one", () => {
    expect(countsAsAnswer("NOT_RETURNED")).toBe(true);
    expect(countsAsAnswer(null)).toBe(true);
    expect(countsAsAnswer("INFO")).toBe(false);
  });
});
