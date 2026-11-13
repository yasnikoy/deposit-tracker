import "server-only";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { istanbulToday, type IsoDate } from "@/domain/business-days";
import type { Role } from "@/domain/roles";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, billsOfLading, documents, emailAttachments, emailBlLinks, emails, replies, replyTypes, requests } from "./db/schema";
import { DomainError } from "./errors";

type EmailRow = typeof emails.$inferSelect;

export type EmailDetail = {
  email: Pick<EmailRow, "id" | "direction" | "fromAddress" | "to" | "cc" | "subject" | "bodyText" | "receivedAt" | "sentAt" | "dryRun" | "rawDocumentId"> & {
    agencyName: string | null;
  };
  attachments: { documentId: number; originalName: string; sizeBytes: number }[];
  /** The B/Ls the email belongs to: its requests (one we sent) or its links (one archived). */
  blNos: string[];
};

/**
 * One email of a B/L, as sent or as archived from Outlook, with its attachments. The app shows
 * it and never interprets it (rule 10); replies are recorded on the B/L.
 */
export function getEmailDetail(db: DbOrTx, actor: AuthUser, emailId: number): EmailDetail {
  authorize(actor, "reply.view");
  const found = db
    .select({ email: emails, agencyName: agencies.name })
    .from(emails)
    .leftJoin(agencies, eq(agencies.id, emails.agencyId))
    // Every archived email; of ours, the agency requests (internal report emails are not shown here).
    .where(and(eq(emails.id, emailId), or(eq(emails.direction, "IN"), isNotNull(emails.agencyId))))
    .get();
  if (!found) throw new DomainError("errors.notFound");
  const { email, agencyName } = found;
  const attachments = db
    .select({ documentId: documents.id, originalName: documents.originalName, sizeBytes: documents.sizeBytes })
    .from(emailAttachments)
    .innerJoin(documents, eq(documents.id, emailAttachments.documentId))
    .where(eq(emailAttachments.emailId, emailId))
    .orderBy(documents.id)
    .all();
  const blIds = [
    ...db.select({ blId: requests.blId }).from(requests).where(eq(requests.emailId, emailId)).all(),
    ...db
      .select({ blId: emailBlLinks.blId })
      .from(emailBlLinks)
      .where(and(eq(emailBlLinks.emailId, emailId), isNull(emailBlLinks.unlinkedAt)))
      .all(),
  ].map((r) => r.blId);
  const blNos = blIds.length
    ? db
        .select({ blNo: billsOfLading.blNo })
        .from(billsOfLading)
        .where(inArray(billsOfLading.id, [...new Set(blIds)]))
        .all()
        .map((b) => b.blNo)
        .sort()
    : [];
  return {
    email: {
      id: email.id,
      direction: email.direction,
      fromAddress: email.fromAddress,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      bodyText: email.bodyText,
      receivedAt: email.receivedAt,
      sentAt: email.sentAt,
      dryRun: email.dryRun,
      rawDocumentId: email.rawDocumentId,
      agencyName,
    },
    attachments,
    blNos,
  };
}

type BlRow = typeof billsOfLading.$inferSelect;

function activeBl(tx: DbOrTx, blId: number): BlRow {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("replies.errors.voided", { bl: bl.blNo });
  return bl;
}

function hasSentRequest(tx: DbOrTx, blId: number): boolean {
  return !!tx
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.blId, blId), eq(requests.sendStatus, "SENT")))
    .get();
}

/** Records one reply on a B/L and applies the lifecycle (only "not yet returned" moves it); returns the audit row. */
function recordReply(
  tx: DbOrTx,
  actor: AuthUser,
  roleUsed: Role,
  input: { bl: BlRow; replyTypeId: number; repliedOn: IsoDate; emailId: number | null; note: string | null },
  now: Date,
): number {
  const { bl } = input;
  const type = tx.select().from(replyTypes).where(eq(replyTypes.id, input.replyTypeId)).get();
  if (!type || !type.active) throw new DomainError("replies.errors.replyType");
  if (!hasSentRequest(tx, bl.id)) throw new DomainError("replies.errors.noRequest", { bl: bl.blNo });

  let status = bl.status as StoredBlStatus;
  if (type.code === "NOT_RETURNED") {
    try {
      status = nextStatus(status, "NOT_RETURNED_REPLY");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("replies.errors.notReturnedStatus", { bl: bl.blNo });
      throw error;
    }
  }
  const at = now.toISOString();
  const reply = tx
    .insert(replies)
    .values({
      blId: bl.id,
      replyTypeId: type.id,
      repliedOn: input.repliedOn,
      emailId: input.emailId,
      note: input.note,
      createdBy: actor.id,
      roleUsed,
      createdAt: at,
    })
    .returning()
    .get();
  if (status !== bl.status) tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
  return writeAudit(
    tx,
    {
      actorUserId: actor.id,
      roleUsed,
      action: "reply.record",
      entityType: "bill_of_lading",
      entityId: bl.id,
      before: { status: bl.status },
      after: { status, replyId: reply.id, replyType: type.name, repliedOn: input.repliedOn, emailId: input.emailId },
      reason: input.note,
    },
    now,
  );
}

/**
 * A reply that did not come by email (e.g. read on the agency portal); it counts like one.
 * One reply often covers several B/Ls: they are recorded together, or none is.
 */
export function recordReplyWithoutEmail(
  db: Db,
  actor: AuthUser,
  input: { blIds: number[]; replyTypeId: number; repliedOn: IsoDate; note: string | null },
  now: Date = new Date(),
): number[] {
  const roleUsed = authorize(actor, "reply.record")!;
  if (input.repliedOn > istanbulToday(now)) throw new DomainError("replies.errors.futureDate");
  return db.transaction((tx) =>
    input.blIds.map((blId) => {
      const bl = activeBl(tx, blId);
      if (input.repliedOn < bl.paidAt) throw new DomainError("replies.errors.beforePayment", { bl: bl.blNo });
      return recordReply(tx, actor, roleUsed, { bl, replyTypeId: input.replyTypeId, repliedOn: input.repliedOn, emailId: null, note: input.note }, now);
    }),
  );
}
