import "server-only";
import { eq } from "drizzle-orm";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { billsOfLading } from "./db/schema";
import { DomainError } from "./errors";

/** Longest description a B/L keeps (a sanity bound, not a business rule). */
export const MAX_DESCRIPTION_LENGTH = 10_000;

/**
 * Audit action of a description change. Written to the audit log (rule 7) but left out of the
 * B/L timeline: the description is a working text, edited at will.
 */
export const DESCRIPTION_AUDIT_ACTION = "bl.description";

/**
 * The B/L's description ("Açıklama"): one free text per B/L that accounting and operations may
 * change at any time; it replaced the team notes. `previous` is the text the user started
 * from: if someone else saved in between, the edit is refused instead of overwriting theirs.
 */
export function updateBlDescription(db: Db, actor: AuthUser, input: { blId: number; description: string; previous: string | null }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.editDescription");
  db.transaction((tx) => {
    const bl = activeBl(tx, input.blId);
    if ((input.previous ?? "") !== (bl.description ?? "")) throw new DomainError("description.errors.changed");
    const next = input.description.trim() || null;
    if (next === bl.description) return;
    save(tx, actor, roleUsed, bl, next, {}, now);
  });
}

/**
 * Adds a line to the description of several B/Ls (the bulk action on All B/Ls). Returns how
 * many B/Ls changed.
 */
export function appendBlDescription(db: Db, actor: AuthUser, input: { blIds: number[]; text: string }, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "bl.editDescription");
  const text = input.text.trim();
  if (text === "") throw new DomainError("description.errors.empty");
  return db.transaction((tx) => {
    const ids = [...new Set(input.blIds)];
    for (const blId of ids) {
      const bl = activeBl(tx, blId);
      const next = bl.description ? `${bl.description}\n${text}` : text;
      if (next.length > MAX_DESCRIPTION_LENGTH) throw new DomainError("description.errors.tooLong", { bl: bl.blNo });
      save(tx, actor, roleUsed, bl, next, { appended: text }, now);
    }
    return ids.length;
  });
}

function activeBl(tx: DbOrTx, blId: number) {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("bls.errors.voided");
  return bl;
}

function save(
  tx: DbOrTx,
  actor: AuthUser,
  roleUsed: ReturnType<typeof authorize>,
  bl: typeof billsOfLading.$inferSelect,
  description: string | null,
  extra: Record<string, unknown>,
  now: Date,
) {
  tx.update(billsOfLading).set({ description, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
  writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: DESCRIPTION_AUDIT_ACTION,
      entityType: "bill_of_lading",
      entityId: bl.id,
      before: { description: bl.description },
      after: { description, ...extra },
    },
    now,
  );
}
