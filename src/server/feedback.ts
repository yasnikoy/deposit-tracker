import "server-only";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { feedback, FEEDBACK_KINDS, users } from "./db/schema";
import { DomainError } from "./errors";
import { notify, usersWithRole } from "./notifications";

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export type FeedbackItem = {
  id: number;
  kind: FeedbackKind;
  body: string;
  page: string | null;
  byName: string;
  createdAt: string;
  closedAt: string | null;
  closedByName: string | null;
};

const EXCERPT = 80;

/** A bug report or feature request from any signed-in user; every admin is notified. */
export function submitFeedback(db: Db, actor: AuthUser, input: { kind: FeedbackKind; body: string; page: string | null }, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "feedback.submit");
  return db.transaction((tx) => {
    const row = tx
      .insert(feedback)
      .values({ kind: input.kind, body: input.body, page: input.page, createdBy: actor.id, createdAt: now.toISOString() })
      .returning()
      .get();
    writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "feedback.submit", entityType: "feedback", entityId: row.id, after: { kind: row.kind, page: row.page } }, now);
    const excerpt = input.body.length > EXCERPT ? `${input.body.slice(0, EXCERPT)}…` : input.body;
    notify(
      tx,
      { userIds: usersWithRole(tx, "ADMIN"), actorId: actor.id, kind: "NEW_FEEDBACK", entityType: "feedback", entityId: row.id, detail: { actor: actor.displayName, kind: row.kind, excerpt } },
      now,
    );
    return row.id;
  });
}

/** Every submission, open ones first, newest first within each. */
export function listFeedback(db: DbOrTx, actor: AuthUser): FeedbackItem[] {
  authorize(actor, "feedback.manage");
  const closer = alias(users, "closer");
  return db
    .select({
      id: feedback.id,
      kind: feedback.kind,
      body: feedback.body,
      page: feedback.page,
      byName: users.displayName,
      createdAt: feedback.createdAt,
      closedAt: feedback.closedAt,
      closedByName: closer.displayName,
    })
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.createdBy))
    .leftJoin(closer, eq(closer.id, feedback.closedBy))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .all()
    .sort((a, b) => Number(a.closedAt !== null) - Number(b.closedAt !== null));
}

/** An admin closes a submission (handled or not to be done) or opens it again. */
export function setFeedbackClosed(db: Db, actor: AuthUser, input: { id: number; closed: boolean }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "feedback.manage");
  db.transaction((tx) => {
    const row = tx.select().from(feedback).where(eq(feedback.id, input.id)).get();
    if (!row) throw new DomainError("errors.notFound");
    if ((row.closedAt !== null) === input.closed) return;
    const at = now.toISOString();
    tx.update(feedback)
      .set(input.closed ? { closedBy: actor.id, closedAt: at } : { closedBy: null, closedAt: null })
      .where(eq(feedback.id, row.id))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: input.closed ? "feedback.close" : "feedback.reopen",
        entityType: "feedback",
        entityId: row.id,
        before: { closedAt: row.closedAt },
        after: { closedAt: input.closed ? at : null },
      },
      now,
    );
  });
}
