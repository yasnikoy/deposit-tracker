import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Role } from "@/domain/roles";
import { OVERRIDABLE_SETTING_KEYS } from "@/domain/settings/definitions";
import { isTranslationKey } from "@/i18n";
import { agencyInputSchema, type AgencyInput, type AgencyOverrides } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, documents } from "./db/schema";
import { DomainError } from "./errors";
import { notify, usersWithRole } from "./notifications";

export type Agency = typeof agencies.$inferSelect;
export type AgencyWithOverrides = Omit<Agency, (typeof agencyOverrideFields)[keyof typeof agencyOverrideFields]> & {
  overrides: AgencyOverrides;
};
export type AgencyListItem = AgencyWithOverrides & { formTemplateName: string | null };

function overridesOf(row: Agency): AgencyOverrides {
  return Object.fromEntries(
    OVERRIDABLE_SETTING_KEYS.map((key) => [key, row[agencyOverrideFields[key]]]),
  ) as AgencyOverrides;
}

function toView(row: Agency): AgencyWithOverrides {
  const view: Record<string, unknown> = { ...row, overrides: overridesOf(row) };
  for (const field of Object.values(agencyOverrideFields)) delete view[field];
  return view as AgencyWithOverrides;
}

/** Agency card data as recorded in the audit log (without override columns). */
function snapshot(row: Agency) {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = toView(row);
  const { overrides: _o, ...card } = rest;
  return card;
}

function nameTaken(tx: DbOrTx, name: string, exceptId?: number): boolean {
  const conditions = [eq(sql`lower(${agencies.name})`, name.toLowerCase())];
  if (exceptId !== undefined) conditions.push(ne(agencies.id, exceptId));
  return !!tx.select({ id: agencies.id }).from(agencies).where(and(...conditions)).get();
}

function requireAgency(tx: DbOrTx, id: number): Agency {
  const row = tx.select().from(agencies).where(eq(agencies.id, id)).get();
  if (!row) throw new DomainError("errors.notFound");
  return row;
}

export function listAgencies(db: Db, actor: AuthUser): AgencyListItem[] {
  authorize(actor, "agency.view");
  return db
    .select({ agency: agencies, formTemplateName: documents.originalName })
    .from(agencies)
    .leftJoin(documents, eq(documents.id, agencies.formTemplateDocumentId))
    .all()
    .map(({ agency, formTemplateName }) => ({ ...toView(agency), formTemplateName }));
}

export function createAgency(db: Db, actor: AuthUser, input: AgencyInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "agency.create");
  const at = now.toISOString();
  return db.transaction((tx) => {
    if (nameTaken(tx, input.name)) throw new DomainError("agencies.errors.nameTaken");
    const row = tx.insert(agencies).values({ ...input, createdAt: at, updatedAt: at }).returning().get();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "agency.create", entityType: "agency", entityId: row.id, after: snapshot(row) },
      now,
    );
    return row.id;
  });
}

/**
 * The agency a payment or opening balance names by text. An agency of that name
 * (case-insensitive) is used as it is; otherwise one is added with only its name, under the
 * entry's own permission, and operations is notified to complete the card. Runs inside the
 * entry's transaction, so a rejected entry adds no agency.
 */
export function agencyForNewName(
  tx: DbOrTx,
  actor: AuthUser,
  action: "agency.createFromPayment" | "agency.createFromOpeningBalance",
  rawName: string,
  now: Date,
): number {
  const name = rawName.trim();
  if (name === "" || name.length > 100) throw new DomainError("payments.errors.agency");
  const existing = tx.select({ id: agencies.id }).from(agencies).where(eq(sql`lower(${agencies.name})`, name.toLowerCase())).get();
  if (existing) return existing.id;
  const roleUsed = authorize(actor, action);
  const at = now.toISOString();
  const row = tx.insert(agencies).values({ name, createdAt: at, updatedAt: at }).returning().get();
  writeAudit(
    tx,
    { actorUserId: actor.id, roleUsed, action: "agency.create", entityType: "agency", entityId: row.id, after: snapshot(row) },
    now,
  );
  notify(
    tx,
    {
      userIds: usersWithRole(tx, "OPERATIONS"),
      actorId: actor.id,
      kind: "NEW_AGENCY",
      entityType: "agency",
      entityId: row.id,
      detail: { actor: actor.displayName, agency: row.name },
    },
    now,
  );
  return row.id;
}

/** Saves the agency card; returns the audit id, which undo takes back. */
export function updateAgency(db: Db, actor: AuthUser, input: { id: number; agency: AgencyInput }, now: Date = new Date()): number[] {
  const roleUsed = authorize(actor, "agency.update");
  return db.transaction((tx) => [saveAgency(tx, actor, roleUsed, input.id, input.agency, now)]);
}

function saveAgency(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, id: number, input: AgencyInput, now: Date): number {
  const before = requireAgency(tx, id);
  if (nameTaken(tx, input.name, id)) throw new DomainError("agencies.errors.nameTaken");
  const after = tx
    .update(agencies)
    .set({ ...input, updatedAt: now.toISOString() })
    .where(eq(agencies.id, id))
    .returning()
    .get();
  if (JSON.stringify(snapshot(before)) === JSON.stringify(snapshot(after))) throw new DomainError("settings.noChanges");
  return writeAudit(
    tx,
    { actorUserId: actor.id, roleUsed, action: "agency.update", entityType: "agency", entityId: id, before: snapshot(before), after: snapshot(after) },
    now,
  );
}

/** The fields of an agency card that a user enters (AgencyInput), as stored now. */
function agencyInputOf(row: Agency): AgencyInput {
  return agencyInputSchema.parse({
    name: row.name,
    active: row.active,
    toRecipients: row.toRecipients,
    ccRecipients: row.ccRecipients,
    bankSenderAliases: row.bankSenderAliases,
    blNumberPatterns: row.blNumberPatterns,
    batchSending: row.batchSending,
    requestChannel: row.requestChannel,
    portalUrl: row.portalUrl ?? "",
    notes: row.notes ?? "",
  });
}

export const INLINE_AGENCY_FIELDS = ["toRecipients", "ccRecipients", "notes"] as const;

/** Inline edit of one contact field from the agencies table; validated like the whole card. */
export function updateAgencyContact(
  db: Db,
  actor: AuthUser,
  input: { id: number; field: (typeof INLINE_AGENCY_FIELDS)[number]; value: string[] | string },
  now: Date = new Date(),
): number[] {
  const roleUsed = authorize(actor, "agency.update");
  return db.transaction((tx) => {
    const current = agencyInputOf(requireAgency(tx, input.id));
    const parsed = agencyInputSchema.safeParse({ ...current, portalUrl: current.portalUrl ?? "", notes: current.notes ?? "", [input.field]: input.value });
    if (!parsed.success) throw new DomainError(isTranslationKey(parsed.error.issues[0]?.message) ? parsed.error.issues[0].message : "errors.validation");
    return [saveAgency(tx, actor, roleUsed, input.id, parsed.data, now)];
  });
}

/** Undo of an agency edit: the card returns to what it was, unless it changed again since. */
export function undoAgencyUpdate(tx: DbOrTx, _actor: AuthUser, audit: { entityId: string | null; before: unknown; after: unknown }, now: Date) {
  const row = requireAgency(tx, Number(audit.entityId));
  if (JSON.stringify(snapshot(row)) !== JSON.stringify(audit.after)) throw new DomainError("undo.errors.movedOn");
  const before = audit.before as ReturnType<typeof snapshot>;
  const restored = agencyInputSchema.parse({ ...before, portalUrl: before.portalUrl ?? "", notes: before.notes ?? "" });
  tx.update(agencies).set({ ...restored, updatedAt: now.toISOString() }).where(eq(agencies.id, row.id)).run();
  return { before: audit.after, after: audit.before };
}

/** Admin-only: per-agency setting overrides; null inherits the global value. */
export function updateAgencyOverrides(
  db: Db,
  actor: AuthUser,
  input: { agencyId: number; overrides: AgencyOverrides; reason: string | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "agency.updateOverrides");
  const values = Object.fromEntries(
    OVERRIDABLE_SETTING_KEYS.map((key) => [agencyOverrideFields[key], input.overrides[key]]),
  );
  db.transaction((tx) => {
    const before = requireAgency(tx, input.agencyId);
    const after = tx
      .update(agencies)
      .set({ ...values, updatedAt: now.toISOString() })
      .where(eq(agencies.id, input.agencyId))
      .returning()
      .get();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "agency.overrides",
        entityType: "agency",
        entityId: input.agencyId,
        before: overridesOf(before),
        after: overridesOf(after),
        reason: input.reason,
      },
      now,
    );
  });
}
