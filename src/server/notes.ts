import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { mentionedUsernames } from "@/domain/mentions";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { billsOfLading, notes, users } from "./db/schema";
import { DomainError } from "./errors";
import { notify } from "./notifications";

const EXCERPT_LENGTH = 140;

/**
 * Adds the same note to one or more B/Ls (a bulk note is one action). Every @username must
 * belong to an active user; each mentioned user is notified once per B/L. Returns the audit
 * ids, which undo takes back together.
 */
export function addNotes(db: Db, actor: AuthUser, input: { blIds: number[]; body: string }, now: Date = new Date()): number[] {
  const roleUsed = authorize(actor, "note.add");
  const body = input.body.trim();
  if (body === "") throw new DomainError("notes.errors.empty");
  return db.transaction((tx) => {
    const names = mentionedUsernames(body);
    const mentioned = names.length
      ? tx
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(and(inArray(sql`lower(${users.username})`, names), eq(users.active, true)))
          .all()
      : [];
    const unknown = names.filter((name) => !mentioned.some((u) => u.username.toLowerCase() === name));
    if (unknown.length > 0) throw new DomainError("notes.errors.unknownMention", { names: unknown.map((n) => `@${n}`).join(", ") });
    const mentionedIds = mentioned.map((u) => u.id);

    const auditIds: number[] = [];
    for (const blId of [...new Set(input.blIds)]) {
      const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
      if (!bl) throw new DomainError("errors.notFound");
      if (bl.voidedAt) throw new DomainError("bls.errors.voided");
      const note = tx.insert(notes).values({ blId, authorId: actor.id, body, mentionedUserIds: mentionedIds, createdAt: now.toISOString() }).returning().get();
      auditIds.push(
        writeAudit(tx, { actorUserId: actor.id, roleUsed, action: "note.add", entityType: "bill_of_lading", entityId: blId, after: { noteId: note.id, body, mentionedUserIds: mentionedIds } }, now),
      );
      notify(
        tx,
        {
          userIds: mentionedIds,
          actorId: actor.id,
          kind: "MENTION",
          entityType: "bill_of_lading",
          entityId: blId,
          detail: { author: actor.displayName, blNo: bl.blNo, excerpt: body.length > EXCERPT_LENGTH ? `${body.slice(0, EXCERPT_LENGTH)}…` : body },
        },
        now,
      );
    }
    return auditIds;
  });
}

export type BlNote = { id: number; body: string; authorName: string; createdAt: string; undone: boolean };

/** A B/L's notes, newest first; undone notes stay visible, marked. */
export function blNotes(db: DbOrTx, blId: number): BlNote[] {
  return db
    .select({ id: notes.id, body: notes.body, authorName: users.displayName, createdAt: notes.createdAt, undoneAt: notes.undoneAt })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.authorId))
    .where(eq(notes.blId, blId))
    .orderBy(desc(notes.id))
    .all()
    .map(({ undoneAt, ...note }) => ({ ...note, undone: undoneAt !== null }));
}

/** Undo of a note: it stays in the history, marked as taken back. */
export function undoNote(tx: DbOrTx, actor: AuthUser, noteId: number, now: Date): { before: unknown; after: unknown } {
  const note = tx.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!note || note.undoneAt) throw new DomainError("undo.errors.alreadyUndone");
  tx.update(notes).set({ undoneAt: now.toISOString(), undoneBy: actor.id }).where(eq(notes.id, noteId)).run();
  return { before: { noteId, undone: false }, after: { noteId, undone: true } };
}

/** Active users that can be mentioned, for the note editor. */
export function mentionableUsers(db: DbOrTx): { username: string; displayName: string }[] {
  return db
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(users.displayName)
    .all();
}
