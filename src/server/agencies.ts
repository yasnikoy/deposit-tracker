import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Role } from "@/domain/roles";
import { OVERRIDABLE_SETTING_KEYS } from "@/domain/settings/definitions";
import { isTranslationKey } from "@/i18n";
import { agencyInputSchema, type AgencyInput, type AgencyOverrides, type AgencyUnitInput } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, agencyUnits, billsOfLading, depositPayments, documents, emails, notifications, refunds, reportEmails } from "./db/schema";
import { DomainError } from "./errors";
import { notify, usersWithRole } from "./notifications";
import { assertUnlinked, type RecordLinks } from "./record-links";

export type Agency = typeof agencies.$inferSelect;
export type AgencyWithOverrides = Omit<Agency, (typeof agencyOverrideFields)[keyof typeof agencyOverrideFields]> & {
  overrides: AgencyOverrides;
};
export type AgencyUnit = typeof agencyUnits.$inferSelect;
/** A unit as the agency card shows and saves it. */
export type AgencyUnitCard = AgencyUnitInput & { id: number };
export type AgencyListItem = AgencyWithOverrides & { formTemplateName: string | null; units: AgencyUnitCard[] };

/** The units of the given agencies (all when omitted), oldest first. */
export function unitsByAgency(tx: DbOrTx, agencyIds?: number[]): Map<number, AgencyUnit[]> {
  const rows = tx
    .select()
    .from(agencyUnits)
    .where(agencyIds ? inArray(agencyUnits.agencyId, agencyIds) : undefined)
    .orderBy(asc(agencyUnits.id))
    .all();
  const map = new Map<number, AgencyUnit[]>();
  for (const row of rows) map.set(row.agencyId, [...(map.get(row.agencyId) ?? []), row]);
  return map;
}

/** Whether the unit is one of the agency's active units (B/Ls take a unit only after creation). */
export const isActiveUnitOf = (tx: DbOrTx, agencyId: number, unitId: number) =>
  (unitsByAgency(tx, [agencyId]).get(agencyId) ?? []).some((u) => u.id === unitId && u.active);

/** Active units per agency, for the pickers where B/Ls are created or changed. */
export function activeUnitOptions(tx: DbOrTx): Record<number, { id: number; name: string }[]> {
  const options: Record<number, { id: number; name: string }[]> = {};
  for (const [agencyId, units] of unitsByAgency(tx)) {
    const active = units.filter((u) => u.active).map(({ id, name }) => ({ id, name }));
    if (active.length) options[agencyId] = active;
  }
  return options;
}

const unitCard = (u: AgencyUnit): AgencyUnitCard => ({ id: u.id, name: u.name, active: u.active, toRecipients: u.toRecipients, ccRecipients: u.ccRecipients });
const unitCardsOf = (tx: DbOrTx, agencyId: number) => (unitsByAgency(tx, [agencyId]).get(agencyId) ?? []).map(unitCard);

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

/** Agency card data as recorded in the audit log (without override columns), with its units. */
function snapshot(tx: DbOrTx, row: Agency) {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = toView(row);
  const { overrides: _o, ...card } = rest;
  return { ...card, units: unitCardsOf(tx, row.id) };
}

/**
 * Saves the card's units: listed ones are updated or added (an id not of this agency adds a
 * new unit), units left off are removed, but only while no B/L names them; those are
 * deactivated instead.
 */
function syncUnits(tx: DbOrTx, agencyId: number, units: AgencyUnitInput[], now: Date) {
  const at = now.toISOString();
  const existing = unitsByAgency(tx, [agencyId]).get(agencyId) ?? [];
  const kept = new Set(units.map((u) => u.id).filter((id) => id !== null));
  for (const gone of existing.filter((u) => !kept.has(u.id))) {
    const named = tx.select({ n: sql<number>`count(*)` }).from(billsOfLading).where(eq(billsOfLading.unitId, gone.id)).get()?.n ?? 0;
    if (named > 0) throw new DomainError("agencies.errors.unitInUse", { unit: gone.name });
    tx.delete(agencyUnits).where(eq(agencyUnits.id, gone.id)).run();
  }
  for (const { id, ...unit } of units) {
    const current = existing.find((u) => u.id === id);
    if (current) {
      tx.update(agencyUnits).set({ ...unit, updatedAt: at }).where(eq(agencyUnits.id, current.id)).run();
    } else {
      tx.insert(agencyUnits).values({ ...unit, agencyId, createdAt: at, updatedAt: at }).run();
    }
  }
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
  const units = unitsByAgency(db);
  return db
    .select({ agency: agencies, formTemplateName: documents.originalName })
    .from(agencies)
    .leftJoin(documents, eq(documents.id, agencies.formTemplateDocumentId))
    .all()
    .map(({ agency, formTemplateName }) => ({ ...toView(agency), formTemplateName, units: (units.get(agency.id) ?? []).map(unitCard) }));
}

function insertAgency(tx: DbOrTx, actor: AuthUser, roleUsed: Role | null, input: AgencyInput, now: Date): number {
  const at = now.toISOString();
  const { units, ...card } = input;
  const row = tx.insert(agencies).values({ ...card, createdAt: at, updatedAt: at }).returning().get();
  syncUnits(tx, row.id, units, now);
  writeAudit(
    tx,
    { actorUserId: actor.id, roleUsed, action: "agency.create", entityType: "agency", entityId: row.id, after: snapshot(tx, row) },
    now,
  );
  return row.id;
}

export function createAgency(db: Db, actor: AuthUser, input: AgencyInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "agency.create");
  return db.transaction((tx) => {
    if (nameTaken(tx, input.name)) throw new DomainError("agencies.errors.nameTaken");
    return insertAgency(tx, actor, roleUsed, input, now);
  });
}

/**
 * Adds the agency cards of an export file (e.g. from a test installation) in one transaction,
 * each audited as `agency.create`. A name that already exists here (case-insensitive), or
 * repeats in the file, is skipped and never overwritten.
 */
export function importAgencies(db: Db, actor: AuthUser, input: { agencies: AgencyInput[] }, now: Date = new Date()): { created: string[]; skipped: string[] } {
  const roleUsed = authorize(actor, "agency.create");
  return db.transaction((tx) => {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const agency of input.agencies) {
      if (nameTaken(tx, agency.name)) {
        skipped.push(agency.name);
        continue;
      }
      insertAgency(tx, actor, roleUsed, agency, now);
      created.push(agency.name);
    }
    return { created, skipped };
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
    { actorUserId: actor.id, roleUsed, action: "agency.create", entityType: "agency", entityId: row.id, after: snapshot(tx, row) },
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
  const before = snapshot(tx, requireAgency(tx, id));
  if (nameTaken(tx, input.name, id)) throw new DomainError("agencies.errors.nameTaken");
  const { units, ...card } = input;
  const row = tx
    .update(agencies)
    .set({ ...card, updatedAt: now.toISOString() })
    .where(eq(agencies.id, id))
    .returning()
    .get();
  syncUnits(tx, id, units, now);
  const after = snapshot(tx, row);
  if (JSON.stringify(before) === JSON.stringify(after)) throw new DomainError("settings.noChanges");
  return writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "agency.update", entityType: "agency", entityId: id, before, after }, now);
}

/** The fields of an agency card that a user enters (AgencyInput), as stored now. */
function agencyInputOf(tx: DbOrTx, row: Agency): AgencyInput {
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
    units: unitCardsOf(tx, row.id),
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
    const current = agencyInputOf(tx, requireAgency(tx, input.id));
    const parsed = agencyInputSchema.safeParse({ ...current, portalUrl: current.portalUrl ?? "", notes: current.notes ?? "", [input.field]: input.value });
    if (!parsed.success) throw new DomainError(isTranslationKey(parsed.error.issues[0]?.message) ? parsed.error.issues[0].message : "errors.validation");
    return [saveAgency(tx, actor, roleUsed, input.id, parsed.data, now)];
  });
}

/** Undo of an agency edit: the card returns to what it was, unless it changed again since. */
export function undoAgencyUpdate(tx: DbOrTx, _actor: AuthUser, audit: { entityId: string | null; before: unknown; after: unknown }, now: Date) {
  const row = requireAgency(tx, Number(audit.entityId));
  if (JSON.stringify(snapshot(tx, row)) !== JSON.stringify(audit.after)) throw new DomainError("undo.errors.movedOn");
  const before = audit.before as ReturnType<typeof snapshot>;
  // Edits recorded before units existed carry none; the agency had none then.
  const { units, ...restored } = agencyInputSchema.parse({ ...before, portalUrl: before.portalUrl ?? "", notes: before.notes ?? "", units: before.units ?? [] });
  tx.update(agencies).set({ ...restored, updatedAt: now.toISOString() }).where(eq(agencies.id, row.id)).run();
  syncUnits(tx, row.id, units, now);
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

const countWhere = (tx: DbOrTx, table: typeof billsOfLading | typeof depositPayments | typeof refunds | typeof emails, id: number) =>
  tx.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.agencyId, id)).get()?.n ?? 0;

/** Every record that names the agency, voided ones included (they stay in history). */
function agencyLinks(tx: DbOrTx, agency: Agency): RecordLinks {
  return {
    bls: countWhere(tx, billsOfLading, agency.id),
    payments: countWhere(tx, depositPayments, agency.id),
    refunds: countWhere(tx, refunds, agency.id),
    emails: countWhere(tx, emails, agency.id),
    reportEmails:
      tx
        .select({ n: sql<number>`count(*)` })
        .from(reportEmails)
        .where(sql`exists (select 1 from json_each(${reportEmails.filters}, '$.agencyIds') where value = ${agency.id})`)
        .get()?.n ?? 0,
    formTemplate: agency.formTemplateDocumentId === null ? 0 : 1,
  };
}

/**
 * Deletes an agency no record names (admin, with a reason), e.g. one entered for a test. Its
 * notifications go with it; the audit log keeps the card. Any other agency is deactivated instead.
 */
export function deleteAgency(db: Db, actor: AuthUser, input: { id: number; reason: string }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "agency.delete");
  db.transaction((tx) => {
    const agency = requireAgency(tx, input.id);
    assertUnlinked(agencyLinks(tx, agency), "agencies.errors.inUse");
    const before = snapshot(tx, agency);
    tx.delete(notifications).where(and(eq(notifications.entityType, "agency"), eq(notifications.entityId, agency.id))).run();
    tx.delete(agencyUnits).where(eq(agencyUnits.agencyId, agency.id)).run();
    tx.delete(agencies).where(eq(agencies.id, agency.id)).run();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "agency.delete", entityType: "agency", entityId: agency.id, before, reason: input.reason },
      now,
    );
  });
}
