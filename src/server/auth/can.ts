import "server-only";
import type { Role } from "@/domain/roles";
import { ForbiddenError } from "../errors";
import type { AuthUser } from "./types";

type Rule<E> = {
  /** Roles that may perform the action, in the order used to pick the "role used". */
  roles: readonly Role[] | "ANY_AUTHENTICATED";
  /** Extra entity-level condition, e.g. "own record only". */
  check?: (user: AuthUser, entity: E) => boolean;
};

const rules = {
  "user.list": { roles: ["ADMIN"] },
  "user.create": { roles: ["ADMIN"] },
  "user.update": { roles: ["ADMIN"] },
  "user.setActive": { roles: ["ADMIN"] },
  "user.resetPassword": { roles: ["ADMIN"] },
  "user.unlock": { roles: ["ADMIN"] },
  "auth.changeOwnPassword": { roles: "ANY_AUTHENTICATED" },
  "preferences.saveOwn": { roles: "ANY_AUTHENTICATED" },
} satisfies Record<string, Rule<never>>;

export type Action = keyof typeof rules;

export type Permission = { allowed: true; role: Role | null } | { allowed: false };

/**
 * The single server-side permission check (rule 6). Returns the role used,
 * which the audit log records; actions open to any signed-in user use none.
 */
export function can(user: AuthUser | null, action: Action, entity?: unknown): Permission {
  if (!user || !user.active) return { allowed: false };
  const rule: Rule<unknown> = rules[action];
  if (rule.check && !rule.check(user, entity)) return { allowed: false };
  if (rule.roles === "ANY_AUTHENTICATED") return { allowed: true, role: null };
  const role = rule.roles.find((r) => user.roles.includes(r));
  return role ? { allowed: true, role } : { allowed: false };
}

/** Like can(), but throws ForbiddenError; returns the role used for the audit log. */
export function authorize(user: AuthUser | null, action: Action, entity?: unknown): Role | null {
  const permission = can(user, action, entity);
  if (!permission.allowed) throw new ForbiddenError();
  return permission.role;
}
