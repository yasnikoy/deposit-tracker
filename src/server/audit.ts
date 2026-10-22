import "server-only";
import type { Role } from "@/domain/roles";
import type { DbOrTx } from "./db/client";
import { auditLog } from "./db/schema";

export type AuditEntry = {
  /** Null for system actions (startup, scheduler, create-admin script). */
  actorUserId: number | null;
  roleUsed: Role | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  undoOf?: number | null;
};

/** Rule 7: call inside the same transaction as the change it records. */
export function writeAudit(tx: DbOrTx, entry: AuditEntry, at: Date = new Date()): number {
  const row = tx
    .insert(auditLog)
    .values({
      at: at.toISOString(),
      actorUserId: entry.actorUserId,
      roleUsed: entry.roleUsed,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      undoOf: entry.undoOf ?? null,
    })
    .returning({ id: auditLog.id })
    .get();
  return row.id;
}
