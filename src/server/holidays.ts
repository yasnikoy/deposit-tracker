import "server-only";
import { asc, eq } from "drizzle-orm";
import type { HolidayKind, IsoDate } from "@/domain/business-days";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db } from "./db/client";
import { holidays } from "./db/schema";
import { DomainError } from "./errors";

export type Holiday = { id: number; date: IsoDate; name: string; kind: HolidayKind };
type HolidayInput = { date: IsoDate; name: string; kind: HolidayKind };

const snapshot = (h: HolidayInput) => ({ date: h.date, name: h.name, kind: h.kind });

export function listHolidays(db: Db, actor: AuthUser): Holiday[] {
  authorize(actor, "holiday.manage");
  return db
    .select({ id: holidays.id, date: holidays.date, name: holidays.name, kind: holidays.kind })
    .from(holidays)
    .orderBy(asc(holidays.date))
    .all();
}

/** Adds holidays, or updates name/kind when the date already exists (bulk entry per year). */
export function saveHolidays(
  db: Db,
  actor: AuthUser,
  input: { holidays: HolidayInput[]; reason: string | null },
  now: Date = new Date(),
): { created: number; updated: number } {
  const roleUsed = authorize(actor, "holiday.manage");
  const at = now.toISOString();
  return db.transaction((tx) => {
    let created = 0;
    let updated = 0;
    for (const holiday of input.holidays) {
      const existing = tx.select().from(holidays).where(eq(holidays.date, holiday.date)).get();
      if (!existing) {
        const row = tx.insert(holidays).values({ ...holiday, createdAt: at, updatedAt: at }).returning().get();
        writeAudit(
          tx,
          { actorUserId: actor.id, roleUsed, action: "holiday.create", entityType: "holiday", entityId: row.id, after: snapshot(row), reason: input.reason },
          now,
        );
        created++;
      } else if (existing.name !== holiday.name || existing.kind !== holiday.kind) {
        tx.update(holidays).set({ name: holiday.name, kind: holiday.kind, updatedAt: at }).where(eq(holidays.id, existing.id)).run();
        writeAudit(
          tx,
          {
            actorUserId: actor.id,
            roleUsed,
            action: "holiday.update",
            entityType: "holiday",
            entityId: existing.id,
            before: snapshot(existing),
            after: snapshot(holiday),
            reason: input.reason,
          },
          now,
        );
        updated++;
      }
    }
    return { created, updated };
  });
}

export function updateHoliday(
  db: Db,
  actor: AuthUser,
  input: { id: number; name: string; kind: HolidayKind; reason: string | null },
  now: Date = new Date(),
): void {
  authorize(actor, "holiday.manage");
  const existing = db.select().from(holidays).where(eq(holidays.id, input.id)).get();
  if (!existing) throw new DomainError("errors.notFound");
  saveHolidays(db, actor, { holidays: [{ date: existing.date, name: input.name, kind: input.kind }], reason: input.reason }, now);
}

/** Holidays are calendar configuration, so they can be removed (with an audit row). */
export function deleteHoliday(db: Db, actor: AuthUser, input: { id: number; reason: string | null }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "holiday.manage");
  db.transaction((tx) => {
    const existing = tx.select().from(holidays).where(eq(holidays.id, input.id)).get();
    if (!existing) throw new DomainError("errors.notFound");
    tx.delete(holidays).where(eq(holidays.id, input.id)).run();
    writeAudit(
      tx,
      { actorUserId: actor.id, roleUsed, action: "holiday.delete", entityType: "holiday", entityId: input.id, before: snapshot(existing), reason: input.reason },
      now,
    );
  });
}
