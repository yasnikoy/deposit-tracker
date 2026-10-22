import { describe, expect, it } from "vitest";
import { authorize, can } from "@/server/auth/can";
import type { AuthUser } from "@/server/auth/types";
import { ForbiddenError } from "@/server/errors";

const user = (roles: AuthUser["roles"], active = true): AuthUser => ({
  id: 1,
  username: "u",
  displayName: "U",
  roles,
  active,
  mustChangePassword: false,
});

describe("can()", () => {
  it("denies anonymous and inactive users", () => {
    expect(can(null, "auth.changeOwnPassword")).toEqual({ allowed: false });
    expect(can(user(["ADMIN"], false), "user.create")).toEqual({ allowed: false });
  });

  it("grants admin actions only to admins and reports the role used", () => {
    expect(can(user(["ADMIN"]), "user.create")).toEqual({ allowed: true, role: "ADMIN" });
    expect(can(user(["ACCOUNTANT", "ADMIN"]), "user.create")).toEqual({ allowed: true, role: "ADMIN" });
    expect(can(user(["ACCOUNTANT", "OPERATIONS"]), "user.create")).toEqual({ allowed: false });
  });

  it("allows self-service actions to any active user without a role", () => {
    expect(can(user(["OPERATIONS"]), "preferences.saveOwn")).toEqual({ allowed: true, role: null });
  });

  it("authorize() throws ForbiddenError when denied", () => {
    expect(() => authorize(user(["OPERATIONS"]), "user.list")).toThrow(ForbiddenError);
    expect(authorize(user(["ADMIN"]), "user.list")).toBe("ADMIN");
  });
});
