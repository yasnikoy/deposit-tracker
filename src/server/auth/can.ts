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
  "system.view": only("ADMIN"),
  "backup.run": only("ADMIN"),
  "update.install": only("ADMIN"),
  "holiday.manage": only("ADMIN"),
  "lists.manage": only("ADMIN"),
  "lists.view": ALL_ROLES,
  "agency.view": ALL_ROLES,
  "agency.create": only("OPERATIONS"),
  // An agency not in the system yet is added by name while entering its payment; operations completes the card.
  "agency.createFromPayment": only("ACCOUNTANT"),
  // A customer named on a payment that is not registered yet (name only; admins complete the card).
  "customer.createFromPayment": only("ACCOUNTANT"),
  // Likewise while moving an Excel record in as an opening balance.
  "agency.createFromOpeningBalance": only("ADMIN"),
  "agency.update": only("OPERATIONS"),
  // Setting overrides are settings, so only admins change them.
  "agency.updateOverrides": only("ADMIN"),
  "agency.updateFormTemplate": only("ADMIN"),
  // Only an agency no record names (e.g. a test entry); others are deactivated instead.
  "agency.delete": only("ADMIN"),
  "document.upload": only("ACCOUNTANT", "OPERATIONS", "ADMIN"),
  "document.view": ALL_ROLES,
  // Money enters through the accountant role; corrections only on own records (rule 7).
  "payment.create": only("ACCOUNTANT"),
  "payment.list": only("ACCOUNTANT"),
  "payment.correct": [{ role: "ACCOUNTANT", when: ownRecord }],
  "payment.void": [{ role: "ACCOUNTANT", when: ownRecord }, { role: "ADMIN" }],
  // A missing receipt or invoice may follow later; it adds evidence and changes no amount.
  "payment.attachEvidence": [{ role: "ACCOUNTANT", when: ownRecord }, { role: "OPERATIONS" }],
  // Incoming refunds and offsets are money records too (rule 7).
  "refund.create": only("ACCOUNTANT"),
  "refund.list": only("ACCOUNTANT"),
  "refund.correct": [{ role: "ACCOUNTANT", when: ownRecord }],
  "refund.attachEvidence": [{ role: "ACCOUNTANT", when: ownRecord }],
  "refund.void": [{ role: "ACCOUNTANT", when: ownRecord }, { role: "ADMIN" }],
  // Money is attributed to B/Ls by operations; only an admin reverses a confirmed allocation (rule 8).
  "allocation.view": only("OPERATIONS", "ADMIN"),
  "allocation.confirm": only("OPERATIONS"),
  "allocation.reverse": only("ADMIN"),
  // Migrated Excel records: the one money record an admin enters (rules 7 and 11).
  "openingBalance.create": only("ADMIN"),
  // The receipt a migrated B/L was saved without; operations attaches missing deposit receipts too.
  "openingBalance.attachEvidence": only("ADMIN", "OPERATIONS"),
  // Operations records and disputes deductions; write-offs need an admin approval (rule 16).
  "deduction.record": only("OPERATIONS"),
  "deduction.dispute": only("OPERATIONS"),
  "writeOff.propose": only("OPERATIONS"),
  "writeOff.view": only("ADMIN"),
  "writeOff.decide": only("ADMIN"),
  // B/Ls are created from payments by operations.
  "bl.view": ALL_ROLES,
  // Aging and agency scorecard (Reports).
  "report.view": ALL_ROLES,
  // The report email to internal addresses.
  "report.sendEmail": only("OPERATIONS"),
  // Importers we pay deposits for; whoever enters payments or B/Ls may register one.
  "customer.view": ALL_ROLES,
  // Customers are a list like the others: an admin keeps them (Listeler).
  "customer.manage": only("ADMIN"),
  // Only a customer no record names; others are deactivated instead.
  "customer.delete": only("ADMIN"),
  // The B/L description ("Açıklama"), a free text accounting and operations keep up to date.
  "bl.editDescription": only("OPERATIONS", "ACCOUNTANT"),
  // Each user sees and marks read only their own notifications.
  "notification.view": ALL_ROLES,
  "bl.create": only("OPERATIONS"),
  // Accountants follow the Operations work lists read-only.
  "bl.viewAwaiting": only("OPERATIONS", "ACCOUNTANT"),
  "bl.update": only("OPERATIONS"),
  // A settled B/L with deductions or an offset is collected once accounting has booked it.
  "bl.recordAccounting": only("ACCOUNTANT"),
  // Which customer a B/L belongs to; not a money field. Admins keep the customer list.
  "bl.setCustomer": only("OPERATIONS", "ACCOUNTANT", "ADMIN"),
  "bl.void": only("OPERATIONS", "ADMIN"),
  "bl.generateForm": only("OPERATIONS"),
  "bl.uploadForm": only("OPERATIONS"),
  // B/L setting overrides are settings, like agency overrides.
  "bl.updateOverrides": only("ADMIN"),
  "request.view": only("OPERATIONS", "ACCOUNTANT"),
  // Preparing a request email locks its B/Ls; queueing it sends.
  "request.prepareEmail": only("OPERATIONS"),
  "request.sendEmail": only("OPERATIONS"),
  // A refund request made outside the app (phone, another mailbox) counts like a sent one.
  "request.recordOutside": only("OPERATIONS"),
  // Moving a B/L's whole deposit to another B/L (accounting or operations); accounting then books it.
  "bl.transferDeposit": only("ACCOUNTANT", "OPERATIONS"),
  // Taking a transfer back while accounting has not booked it yet.
  "bl.reverseTransfer": only("ADMIN"),
  // Sending a sent request email again (wrong recipients, or redirected by a reply); not a new request.
  "request.resend": only("OPERATIONS"),
  "email.sendTest": only("ADMIN"),
  // Agency replies are read and recorded by operations (the Replies screen).
  "reply.view": only("OPERATIONS"),
  "reply.record": only("OPERATIONS"),
  // Accepting or dismissing a match suggestion, and linking a mailbox message by hand.
  "email.link": only("OPERATIONS"),
  "standingDocument.view": ALL_ROLES,
  // A customer's signature circular and power of attorney, on its card.
  "standingDocument.manage": only("OPERATIONS", "ADMIN"),
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
