import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, updateKind } from "@/domain/versions";

describe("versions", () => {
  it("parses release tags and plain versions, nothing else", () => {
    expect(parseVersion("v0.8.1")).toEqual([0, 8, 1]);
    expect(parseVersion("1.10.0")).toEqual([1, 10, 0]);
    expect(parseVersion("v1.2")).toBeNull();
    expect(parseVersion("v1.2.3-beta")).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.8.1", "0.8.2")).toBeLessThan(0);
  });

  it("offers newer versions of the same major; a new major needs the manual steps; never older", () => {
    expect(updateKind("0.8.1", "v0.9.0")).toBe("install");
    expect(updateKind("1.0.0", "v1.0.1")).toBe("install");
    expect(updateKind("1.4.2", "v2.0.0")).toBe("manual");
    expect(updateKind("0.9.0", "v1.0.0")).toBe("manual");
    expect(updateKind("0.9.0", "v0.9.0")).toBe("none");
    expect(updateKind("0.9.0", "v0.8.5")).toBe("none");
    expect(updateKind("0.9.0", "nightly")).toBe("none");
  });
});
