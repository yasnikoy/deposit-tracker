import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NOTIFICATION_SETTINGS, type NotificationKind } from "@/domain/notifications";
import type { Role } from "@/domain/roles";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { auditLog, billsOfLading, notifications, replies, requests, userRoles, users } from "./db/schema";
import { unprocessedReplies } from "./replies";
import { getSetting } from "./settings";
import { customerScope } from "./preferences";

export type NotificationDetail = Record<string, string | number | null>;

/**
 * Notifies users of an event, if its kind is switched on. Inactive users and the actor
 * themselves are skipped; an overdue reply notifies each user only once.
 */
export function notify(
  tx: DbOrTx,
  input: { userIds: number[]; actorId: number | null; kind: Exclude<NotificationKind, "MENTION">; entityType: string; entityId: number; detail: NotificationDetail },
  now: Date = new Date(),
): void {
  if (!getSetting(NOTIFICATION_SETTINGS[input.kind], {}, tx)) return;
  const ids = [...new Set(input.userIds)].filter((id) => id !== input.actorId);
  if (ids.length === 0) return;
  const active = tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true))).all();
  if (active.length === 0) return;
  tx.insert(notifications)
    .values(active.map(({ id }) => ({ userId: id, kind: input.kind, entityType: input.entityType, entityId: input.entityId, detail: input.detail, createdAt: now.toISOString() })))
    .onConflictDoNothing()
    .run();
}

/** Active users holding a role. */
export function usersWithRole(tx: DbOrTx, role: Role): number[] {
  return tx
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, role), eq(users.active, true)))
    .all()
    .map((u) => u.id);
}

/**
 * Operations users who worked on a B/L: created it, recorded or sent its requests, recorded
 * its replies, or wrote its description (or, before that, notes on it). Without any, every
 * operations user (shared pool).
 */
export function operationsOnBl(tx: DbOrTx, blId: number): number[] {
  const bl = tx.select({ createdBy: billsOfLading.createdBy }).from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  const involved = new Set<number>([
    ...(bl ? [bl.createdBy] : []),
    ...tx.select({ id: requests.createdBy }).from(requests).where(eq(requests.blId, blId)).all().map((r) => r.id),
    ...tx.select({ id: replies.createdBy }).from(replies).where(eq(replies.blId, blId)).all().map((r) => r.id),
    ...tx
      .select({ id: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "bill_of_lading"), eq(auditLog.entityId, String(blId)), inArray(auditLog.action, ["bl.description", "note.add"])))
      .all()
      .flatMap((r) => (r.id === null ? [] : [r.id])),
  ]);
  const operations = usersWithRole(tx, "OPERATIONS");
  const onBl = operations.filter((id) => involved.has(id));
  return onBl.length > 0 ? onBl : operations;
}

export type NotificationItem = {
  id: number;
  kind: NotificationKind;
  entityType: string;
  entityId: number;
  detail: NotificationDetail;
  createdAt: string;
  read: boolean;
};

const LIST_LIMIT = 100;

/** The viewer's own notifications, newest first. */
export function listNotifications(db: DbOrTx, actor: AuthUser): NotificationItem[] {
  authorize(actor, "notification.view");
  const shown = inCustomerFilter(db, actor);
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, actor.id))
    .orderBy(desc(notifications.id))
    .all()
    .filter(shown)
    .slice(0, LIST_LIMIT)
    .map((n) => ({ id: n.id, kind: n.kind, entityType: n.entityType, entityId: n.entityId, detail: n.detail, createdAt: n.createdAt, read: n.readAt !== null }));
}

export function unreadNotificationCount(db: DbOrTx, actor: AuthUser): number {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)))
    .all()
    .filter(inCustomerFilter(db, actor)).length;
}

/** Notifications about a B/L outside the viewer's customer filter are not shown (others always are). */
function inCustomerFilter(db: DbOrTx, actor: AuthUser): (n: { entityType: string; entityId: number }) => boolean {
  const inScope = customerScope(db, actor);
  const customerOf = new Map(db.select({ id: billsOfLading.id, customerId: billsOfLading.customerId }).from(billsOfLading).all().map((b) => [b.id, b.customerId]));
  return (n) => n.entityType !== "bill_of_lading" || inScope(customerOf.get(n.entityId) ?? null);
}

/** Marks the viewer's own notifications read (all of them without ids); others' are untouched. */
export function markNotificationsRead(db: Db, actor: AuthUser, input: { ids?: number[] }, now: Date = new Date()): void {
  authorize(actor, "notification.view");
  const own = and(eq(notifications.userId, actor.id), isNull(notifications.readAt));
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(input.ids ? and(own, inArray(notifications.id, input.ids)) : own)
    .run();
}

/**
 * Runs with every mailbox poll: each reply that passed the unprocessed warning notifies every
 * operations user once (the unique index keeps repeats out).
 */
export function notifyOverdueReplies(tx: DbOrTx, now: Date = new Date()): void {
  const overdue = unprocessedReplies(tx, now).filter((r) => r.overdue);
  if (overdue.length === 0) return;
  const operations = usersWithRole(tx, "OPERATIONS");
  for (const reply of overdue) {
    notify(
      tx,
      {
        userIds: operations,
        actorId: null,
        kind: "UNPROCESSED_REPLY",
        entityType: "email",
        entityId: reply.emailId,
        detail: { agency: reply.agencyName, subject: reply.subject, receivedAt: reply.receivedAt },
      },
      now,
    );
  }
}
