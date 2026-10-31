import "server-only";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { InvalidTransitionError, statusAfterUndo, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { writeAudit } from "./audit";
import { authorize, can, type Action } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import {
  auditLog,
  billsOfLading,
  containers,
  documents,
  emailAttachments,
  emailBlLinks,
  emailMatchSuggestions,
  replies,
  replyTypes,
  requests,
} from "./db/schema";
import { DomainError } from "./errors";
import { nameBlDocuments } from "./files";
import { activeLedgerEntries, compensateLedgerEntry } from "./ledger";
import { undoNote } from "./notes";
import { getSetting } from "./settings";

type AuditRow = typeof auditLog.$inferSelect;
type BlRow = typeof billsOfLading.$inferSelect;
type Snapshot = { before: unknown; after: unknown };

/**
 * Rule 17: the actions a user can take back within the undo window, each with the permission
 * it needs and its compensation. Confirmed allocations, sent emails, money records,
 * write-offs and settings are not listed, so they can never be undone. Inline edits join in
 * build step 7e.
 */
const UNDOABLE: Record<string, { permission: Action; undo: (tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date) => Snapshot }> = {
  "reply.record": { permission: "reply.record", undo: undoReply },
  "deduction.statement": { permission: "deduction.record", undo: undoStatementDeduction },
  "email.link": { permission: "email.link", undo: undoEmailLink },
  "form.upload": { permission: "bl.uploadForm", undo: undoFormUpload },
  "bl.update": { permission: "bl.update", undo: undoBlUpdate },
  "note.add": { permission: "note.add", undo: (tx, actor, audit, now) => undoNote(tx, actor, (audit.after as { noteId: number }).noteId, now) },
};

const isUndone = (tx: DbOrTx, auditId: number) => !!tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.undoOf, auditId)).get();
const withinWindow = (tx: DbOrTx, audit: AuditRow, now: Date) =>
  now.getTime() - new Date(audit.at).getTime() <= getSetting("rules.undoWindowMinutes", {}, tx) * 60_000;

/** Whether the viewer may still undo this audit row: own, undoable, within the window, not undone yet. */
export function canUndo(tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date): boolean {
  const entry = UNDOABLE[audit.action];
  return !!entry && audit.actorUserId === actor.id && withinWindow(tx, audit, now) && can(actor, entry.permission).allowed && !isUndone(tx, audit.id);
}

/**
 * Takes back the user's own recent actions (one action may have several audit rows, e.g. a
 * bulk reply), all or nothing. Each undo writes compensating rows or flags, never deletes,
 * and an audit row referencing the original.
 */
export function undoActions(db: Db, actor: AuthUser, input: { auditIds: number[] }, now: Date = new Date()): void {
  db.transaction((tx) => {
    for (const auditId of [...new Set(input.auditIds)]) {
      const audit = tx.select().from(auditLog).where(eq(auditLog.id, auditId)).get();
      if (!audit) throw new DomainError("errors.notFound");
      const entry = UNDOABLE[audit.action];
      if (!entry) throw new DomainError("undo.errors.notUndoable");
      if (audit.actorUserId !== actor.id) throw new DomainError("undo.errors.notOwn");
      const roleUsed = authorize(actor, entry.permission);
      if (isUndone(tx, audit.id)) throw new DomainError("undo.errors.alreadyUndone");
      if (!withinWindow(tx, audit, now)) throw new DomainError("undo.errors.expired", { minutes: getSetting("rules.undoWindowMinutes", {}, tx) });
      const { before, after } = entry.undo(tx, actor, audit, now);
      writeAudit(
        tx,
        { actorUserId: actor.id, roleUsed, action: "undo", entityType: audit.entityType, entityId: audit.entityId, before, after: { ...(after as object), undoneAction: audit.action }, undoOf: audit.id },
        now,
      );
    }
  });
}

function activeBl(tx: DbOrTx, blId: number): BlRow {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("bls.errors.voided");
  return bl;
}

/** The status the B/L returns to, or a "moved on" error when something happened since (rule 9). */
function restoredStatus(bl: BlRow, before: StoredBlStatus, after: StoredBlStatus): StoredBlStatus {
  try {
    return statusAfterUndo({ current: bl.status as StoredBlStatus, before, after });
  } catch (error) {
    if (error instanceof InvalidTransitionError) throw new DomainError("undo.errors.movedOn");
    throw error;
  }
}

function setStatus(tx: DbOrTx, bl: BlRow, status: StoredBlStatus, now: Date) {
  if (status !== bl.status) tx.update(billsOfLading).set({ status, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
}

/**
 * A recorded reply no longer counts. A "not yet returned" reply that moved the B/L to
 * AWAITING_RETURN takes it back to REQUESTED, unless another such reply since the last
 * request keeps it there.
 */
function undoReply(tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date): Snapshot {
  const { replyId, status: statusAfter } = audit.after as { replyId: number; status: StoredBlStatus };
  const { status: statusBefore } = audit.before as { status: StoredBlStatus };
  const reply = tx.select().from(replies).where(eq(replies.id, replyId)).get();
  if (!reply || reply.undoneAt) throw new DomainError("undo.errors.alreadyUndone");
  const bl = activeBl(tx, reply.blId);

  let status = bl.status as StoredBlStatus;
  if (statusBefore !== statusAfter) {
    const lastRequest = tx
      .select({ requestedOn: requests.requestedOn })
      .from(requests)
      .where(and(eq(requests.blId, bl.id), eq(requests.type, "REFUND"), eq(requests.sendStatus, "SENT")))
      .orderBy(desc(requests.requestedOn))
      .get();
    const otherNotReturned = tx
      .select({ id: replies.id })
      .from(replies)
      .innerJoin(replyTypes, eq(replyTypes.id, replies.replyTypeId))
      .where(
        and(
          eq(replies.blId, bl.id),
          ne(replies.id, reply.id),
          isNull(replies.undoneAt),
          eq(replyTypes.code, "NOT_RETURNED"),
          gte(replies.repliedOn, lastRequest?.requestedOn ?? ""),
        ),
      )
      .get();
    if (!otherNotReturned) status = restoredStatus(bl, statusBefore, statusAfter);
  }
  tx.update(replies).set({ undoneAt: now.toISOString(), undoneBy: actor.id }).where(eq(replies.id, reply.id)).run();
  setStatus(tx, bl, status, now);
  return { before: { status: bl.status, replyId }, after: { status } };
}

/** The statement deductions are compensated; a B/L they closed reopens. */
function undoStatementDeduction(tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date): Snapshot {
  const { entryIds, status: statusAfter } = audit.after as { entryIds: number[]; status: StoredBlStatus };
  const bl = activeBl(tx, Number(audit.entityId));
  const active = activeLedgerEntries(tx, bl.id, ["DEDUCTION"]).filter((e) => entryIds.includes(e.id));
  if (active.length !== entryIds.length) throw new DomainError("undo.errors.movedOn");
  const status = restoredStatus(bl, (audit.before as { status: StoredBlStatus }).status, statusAfter);
  for (const entry of active) compensateLedgerEntry(tx, entry, actor.id, now);
  setStatus(tx, bl, status, now);
  return { before: { status: bl.status, entryIds }, after: { status } };
}

/** A link made by hand or by accepting a match is taken back, while no reply was recorded on it. */
function undoEmailLink(tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date): Snapshot {
  const { emailId, source } = audit.after as { emailId: number; source: "SUGGESTION" | "MANUAL" };
  const blId = Number(audit.entityId);
  const link = tx.select().from(emailBlLinks).where(and(eq(emailBlLinks.emailId, emailId), eq(emailBlLinks.blId, blId))).get();
  if (!link || link.unlinkedAt) throw new DomainError("undo.errors.alreadyUndone");
  const replied = tx.select({ id: replies.id }).from(replies).where(and(eq(replies.emailId, emailId), eq(replies.blId, blId), isNull(replies.undoneAt))).get();
  if (replied) throw new DomainError("undo.errors.replyRecorded");
  const at = now.toISOString();
  tx.update(emailBlLinks).set({ unlinkedAt: at, unlinkedBy: actor.id }).where(and(eq(emailBlLinks.emailId, emailId), eq(emailBlLinks.blId, blId))).run();
  // An accepted match is offered again.
  if (source === "SUGGESTION") {
    tx.update(emailMatchSuggestions)
      .set({ state: "OPEN", resolvedBy: null, resolvedAt: null })
      .where(and(eq(emailMatchSuggestions.emailId, emailId), eq(emailMatchSuggestions.blId, blId), eq(emailMatchSuggestions.state, "ACCEPTED")))
      .run();
  }
  return { before: { emailId, source }, after: { unlinked: true } };
}

/** An uploaded form is withdrawn, while no email carried it; the previous form is current again. */
function undoFormUpload(tx: DbOrTx, actor: AuthUser, audit: AuditRow, now: Date): Snapshot {
  const { documentId } = audit.after as { documentId: number };
  const doc = tx.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!doc || doc.withdrawnAt) throw new DomainError("undo.errors.alreadyUndone");
  activeBl(tx, Number(audit.entityId));
  if (tx.select({ emailId: emailAttachments.emailId }).from(emailAttachments).where(eq(emailAttachments.documentId, documentId)).get()) {
    throw new DomainError("undo.errors.formSent");
  }
  tx.update(documents).set({ withdrawnAt: now.toISOString(), withdrawnBy: actor.id }).where(eq(documents.id, documentId)).run();
  return { before: { documentId }, after: { withdrawn: true } };
}

/** The B/L number and containers return to what they were, if nobody changed them since. */
function undoBlUpdate(tx: DbOrTx, _actor: AuthUser, audit: AuditRow, now: Date): Snapshot {
  const before = audit.before as { blNo: string; containers: string[] };
  const after = audit.after as { blNo: string; containers: string[] };
  const bl = activeBl(tx, Number(audit.entityId));
  const current = tx.select({ containerNo: containers.containerNo }).from(containers).where(eq(containers.blId, bl.id)).orderBy(containers.id).all().map((c) => c.containerNo);
  if (bl.blNo !== after.blNo || JSON.stringify(current) !== JSON.stringify(after.containers)) throw new DomainError("undo.errors.movedOn");
  if (before.blNo !== bl.blNo) {
    // The same checks as an edit: the number is editable until the first request, and unique.
    if (bl.status !== "PAID") throw new DomainError("bls.errors.blNoLocked");
    const taken = tx
      .select({ id: billsOfLading.id })
      .from(billsOfLading)
      .where(and(eq(billsOfLading.blNo, before.blNo), isNull(billsOfLading.voidedAt), ne(billsOfLading.id, bl.id)))
      .get();
    if (taken) throw new DomainError("bls.errors.blNoTaken");
    tx.update(billsOfLading).set({ blNo: before.blNo, updatedAt: now.toISOString() }).where(eq(billsOfLading.id, bl.id)).run();
    nameBlDocuments(tx, { ...bl, blNo: before.blNo });
  }
  if (JSON.stringify(current) !== JSON.stringify(before.containers)) {
    tx.delete(containers).where(eq(containers.blId, bl.id)).run();
    if (before.containers.length > 0) tx.insert(containers).values(before.containers.map((containerNo) => ({ blId: bl.id, containerNo }))).run();
  }
  return { before: after, after: before };
}

/** Audit rows of the given ids the viewer may undo now (for the timeline). */
export function undoableAuditIds(tx: DbOrTx, actor: AuthUser, auditIds: number[], now: Date): Set<number> {
  if (auditIds.length === 0) return new Set();
  const rows = tx.select().from(auditLog).where(and(inArray(auditLog.id, auditIds), eq(auditLog.actorUserId, actor.id))).all();
  return new Set(rows.filter((row) => canUndo(tx, actor, row, now)).map((row) => row.id));
}
