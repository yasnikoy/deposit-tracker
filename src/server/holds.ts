import "server-only";
import { eq } from "drizzle-orm";
import { istanbulToday, type IsoDate } from "@/domain/business-days";
import { HOLDABLE, isOnHold } from "@/domain/hold";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { billsOfLading, holdReasons } from "./db/schema";
import { DomainError } from "./errors";

type BlRow = typeof billsOfLading.$inferSelect;

function openBl(tx: DbOrTx, blId: number): BlRow {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("bls.errors.voided");
  return bl;
}

/**
 * Puts an open B/L on hold (Beklemeye al): it leaves the due list and the daily work, while its
 * status and money stay as they are (still outstanding in balances and reports). A reason from
 * the list is required; an optional review date brings it back on that day. Placing it again
 * replaces the reason, note and date. Audited.
 */
export function holdBl(
  db: Db,
  actor: AuthUser,
  input: { blId: number; reasonId: number; note: string | null; until: IsoDate | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "bl.hold");
  db.transaction((tx) => {
    const bl = openBl(tx, input.blId);
    if (!(HOLDABLE as readonly string[]).includes(bl.status)) throw new DomainError("holds.errors.notOpen", { bl: bl.blNo });
    const reason = tx.select().from(holdReasons).where(eq(holdReasons.id, input.reasonId)).get();
    if (!reason || !reason.active) throw new DomainError("holds.errors.reason");
    if (input.until !== null && input.until <= istanbulToday(now)) throw new DomainError("holds.errors.untilPast");
    const at = now.toISOString();
    tx.update(billsOfLading)
      .set({ holdReasonId: reason.id, holdNote: input.note, holdUntil: input.until, heldBy: actor.id, heldAt: at, updatedAt: at })
      .where(eq(billsOfLading.id, bl.id))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.hold",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: bl.holdReasonId === null ? null : { holdReasonId: bl.holdReasonId, holdNote: bl.holdNote, holdUntil: bl.holdUntil },
        after: { holdReasonId: reason.id, reason: reason.name, holdUntil: input.until },
        reason: input.note,
      },
      now,
    );
  });
}

/** Takibe geri al: the B/L is back in the work lists at once, due as its dates say. Audited. */
export function releaseHold(db: Db, actor: AuthUser, input: { blId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.hold");
  db.transaction((tx) => {
    const bl = openBl(tx, input.blId);
    if (!isOnHold(bl, istanbulToday(now))) throw new DomainError("holds.errors.notHeld", { bl: bl.blNo });
    tx.update(billsOfLading)
      .set({ holdReasonId: null, holdNote: null, holdUntil: null, heldBy: null, heldAt: null, updatedAt: now.toISOString() })
      .where(eq(billsOfLading.id, bl.id))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.releaseHold",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { holdReasonId: bl.holdReasonId, holdNote: bl.holdNote, holdUntil: bl.holdUntil },
      },
      now,
    );
  });
}
