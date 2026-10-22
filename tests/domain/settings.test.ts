import { describe, expect, it } from "vitest";
import {
  OVERRIDABLE_SETTING_KEYS,
  parseSettingValue,
  settingDefinitions,
} from "@/domain/settings/definitions";
import { resolveSetting } from "@/domain/settings/resolve";
import seed from "../../seed/settings.json";

describe("resolveSetting", () => {
  it("prefers the B/L override, then the agency override, then the global value", () => {
    expect(resolveSetting({ global: 7, agency: 5, bl: 3 })).toBe(3);
    expect(resolveSetting({ global: 7, agency: 5, bl: null })).toBe(5);
    expect(resolveSetting({ global: 7, agency: null, bl: null })).toBe(7);
    expect(resolveSetting({ global: 7 })).toBe(7);
  });

  it("treats 0 as a real override, only null inherits", () => {
    expect(resolveSetting({ global: 7, agency: 0 })).toBe(0);
    expect(resolveSetting({ global: 7, agency: 5, bl: 0 })).toBe(0);
  });
});

describe("setting definitions", () => {
  it("has a valid seed value for every setting, and no seed value without a definition", () => {
    const seeded = seed.settings as Record<string, unknown>;
    expect(Object.keys(seeded).sort()).toEqual(Object.keys(settingDefinitions).sort());
    for (const [key, value] of Object.entries(seeded)) {
      expect(() => parseSettingValue(key as keyof typeof settingDefinitions, value), key).not.toThrow();
    }
  });

  it("makes only the request-timing durations overridable", () => {
    expect([...OVERRIDABLE_SETTING_KEYS].sort()).toEqual(
      [
        "durations.firstRequestDueDays",
        "durations.followUpDays",
        "durations.statementFollowUpDays",
        "durations.statementRequestDays",
        "durations.upcomingDays",
      ].sort(),
    );
  });

  it("validates weekend days and aging bucket edges", () => {
    expect(() => parseSettingValue("calendar.weekendDays", [6, 7])).not.toThrow();
    expect(() => parseSettingValue("calendar.weekendDays", [1, 2, 3, 4, 5, 6, 7])).toThrow();
    expect(() => parseSettingValue("calendar.weekendDays", [6, 6])).toThrow();
    expect(() => parseSettingValue("calendar.weekendDays", [0])).toThrow();
    expect(() => parseSettingValue("durations.agingBucketEdges", [20, 40, 60])).not.toThrow();
    expect(() => parseSettingValue("durations.agingBucketEdges", [40, 20])).toThrow();
    expect(() => parseSettingValue("backups.dailyTime", "12:30")).not.toThrow();
    expect(() => parseSettingValue("backups.dailyTime", "24:00")).toThrow();
  });
});
