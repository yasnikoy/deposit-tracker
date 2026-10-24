import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { OVERRIDABLE_SETTING_KEYS } from "@/domain/settings/definitions";
import type { AgencyInput, AgencyOverrides } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, documents } from "./db/schema";
import { DomainError } from "./errors";

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

export function updateAgency(db: Db, actor: AuthUser, input: { id: number; agency: AgencyInput }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "agency.update");
  db.transaction((tx) => {
    const before = requireAgency(tx, input.id);
    if (nameTaken(tx, input.agency.name, input.id)) throw new DomainError("agencies.errors.nameTaken");
    const after = tx
      .update(agencies)
      .set({ ...input.agency, updatedAt: now.toISOString() })
      .where(eq(agencies.id, input.id))
      .returning()
      .get();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "agency.update",
        entityType: "agency",
        entityId: input.id,
        before: snapshot(before),
        after: snapshot(after),
      },
      now,
    );
  });
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
