import { describe, expect, it } from "vitest";
import { findFileNo, isValidFileNo, normalizeFileNo } from "@/domain/file-number";

describe("file numbers", () => {
  it("drop the T prefix and keep the year-hyphen-five-digits form", () => {
    expect(normalizeFileNo(" t26-12345 ")).toBe("26-12345");
    expect(normalizeFileNo("2612345")).toBe("26-12345");
    expect(normalizeFileNo("26-12345")).toBe("26-12345");
    expect(isValidFileNo("26-12345")).toBe(true);
    for (const wrong of ["26-1234", "26-123456", "T26-12345", "2026-12345", "ab-12345"]) expect(isValidFileNo(wrong)).toBe(false);
  });

  it("are found in transfer descriptions with or without the T, never inside longer numbers", () => {
    expect(findFileNo("ORNEK T26-90815 MEDU1234567 DEPOZITO")).toBe("26-90815");
    expect(findFileNo("BETA 25-00012 DEPO")).toBe("25-00012");
    expect(findFileNo("ORNEK T26-908150 DEPO")).toBeNull();
    expect(findFileNo("REF 1226-90815")).toBeNull();
    expect(findFileNo("MEDU1234567")).toBeNull();
  });
});
