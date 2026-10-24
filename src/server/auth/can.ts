import "server-only";
import type { Role } from "@/domain/roles";
import { ForbiddenError } from "../errors";
import type { AuthUser } from "./types";

type Grant = {
  role: Role;
  /** Extra entity-level condition for this role, e.g. "own record only". */
  when?: (user: AuthUser, entity: never) => boolean;
};
type Rule = readonly Grant[] | "ANY_AUTHENTICATED";

const only = (...roles: Role[]): Grant[] => roles.map((role) => ({ role }));
const ALL_ROLES = only("OPERATIONS", "ACCOUNTANT", "ADMIN");
const ownRecord = (user: AuthUser, entity: { createdBy: number }) => entity.createdBy === user.id;

const rules = {
  "user.list": only("ADMIN"),
  "user.create": only("ADMIN"),
  "user.update": only("ADMIN"),
  "user.setActive": only("ADMIN"),
  "user.resetPassword": only("ADMIN"),
  "user.unlock": only("ADMIN"),
  "settings.view": only("ADMIN"),
  "settings.update": only("ADMIN"),
  "holiday.manage": only("ADMIN"),
  "lists.manage": only("ADMIN"),
  "lists.view": ALL_ROLES,
  "agency.view": ALL_ROLES,
  "agency.create": only("OPERATIONS"),
  "agency.update": only("OPERATIONS"),
  // Setting overrides are settings, so only admins change them.
  "agency.updateOverrides": only("ADMIN"),
  "agency.updateFormTemplate": only("ADMIN"),
  "document.upload": only("ACCOUNTANT", "OPERATIONS", "ADMIN"),
  "document.view": ALL_ROLES,
  // Money enters through the accountant role; corrections only on own records (rule 7).
  "payment.create": only("ACCOUNTANT"),
  "payment.viewOwn": only("ACCOUNTANT"),
  "payment.correct": [{ role: "ACCOUNTANT", when: ownRecord }],
  "payment.void": [{ role: "ACCOUNTANT", when: ownRecord }, { role: "ADMIN" }],
  // B/Ls are created from payments by operations.
  "bl.view": ALL_ROLES,
  "bl.create": only("OPERATIONS"),
  "bl.update": only("OPERATIONS"),
  "bl.void": only("OPERATIONS", "ADMIN"),
  "bl.generateForm": only("OPERATIONS"),
  "bl.uploadForm": only("OPERATIONS"),
  "auth.changeOwnPassword": "ANY_AUTHENTICATED",
  "preferences.saveOwn": "ANY_AUTHENTICATED",
} satisfies Record<string, Rule>;

export type Action = keyof typeof rules;

export type Permission = { allowed: true; role: Role | null } | { allowed: false };

/**
 * The single server-side permission check (rule 6). Returns the role used —
 * the first grant the user holds whose condition passes — for the audit log.
 * Actions open to any signed-in user use no role.
 */
export function can(user: AuthUser | null, action: Action, entity?: unknown): Permission {
  if (!user || !user.active) return { allowed: false };
  const rule: Rule = rules[action];
  if (rule === "ANY_AUTHENTICATED") return { allowed: true, role: null };
  for (const grant of rule) {
    if (!user.roles.includes(grant.role)) continue;
    if (grant.when && (entity === undefined || !grant.when(user, entity as never))) continue;
    return { allowed: true, role: grant.role };
  }
  return { allowed: false };
}

/** Like can(), but throws ForbiddenError; returns the role used for the audit log. */
export function authorize(user: AuthUser | null, action: Action, entity?: unknown): Role | null {
  const permission = can(user, action, entity);
  if (!permission.allowed) throw new ForbiddenError();
  return permission.role;
}
