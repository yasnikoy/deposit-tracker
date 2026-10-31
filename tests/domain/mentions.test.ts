import { describe, expect, it } from "vitest";
import { onOrAfterWeekday } from "@/domain/business-days";
import { mentionedUsernames } from "@/domain/mentions";

describe("mentions", () => {
  it("finds @usernames anywhere in a note, once each, lower-cased", () => {
    expect(mentionedUsernames("@ayse bakar mısın? @Mehmet.K ve @ayse, acente arandı.")).toEqual(["ayse", "mehmet.k"]);
  });

  it("ignores email addresses and a lone @", () => {
    expect(mentionedUsernames("iade@msc.example adresine yazıldı @ sonra")).toEqual([]);
  });

  it("drops sentence punctuation after a name", () => {
    expect(mentionedUsernames("Bilgi: @ali. Sonra @veli-2!")).toEqual(["ali", "veli-2"]);
  });

  it("needs at least two characters, like usernames", () => {
    expect(mentionedUsernames("@a @ab")).toEqual(["ab"]);
  });
});

describe("weekly date", () => {
  it("is the given ISO weekday on or after a date", () => {
    // Thu 22 Oct 2026.
    expect(onOrAfterWeekday("2026-10-22", 4)).toBe("2026-10-22");
    expect(onOrAfterWeekday("2026-10-22", 1)).toBe("2026-10-26");
    expect(onOrAfterWeekday("2026-10-22", 7)).toBe("2026-10-25");
  });
});
