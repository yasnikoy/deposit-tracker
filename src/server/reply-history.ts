import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { IsoDate } from "@/domain/business-days";
import { countsAsAnswer } from "@/domain/replies";
import type { DbOrTx } from "./db/client";
import { replies, replyTypes } from "./db/schema";

export type ReplyHistory = {
  /** The last reply that counts as an answer, for the follow-up clock (info-only replies do not). */
  lastAnswerOn: IsoDate | null;
  /** The last recorded reply of any type, for display. */
  last: { replyTypeId: number; typeName: string; repliedOn: IsoDate } | null;
};

/** Recorded agency replies per B/L, latest first by reply date. */
export function replyHistory(db: DbOrTx, blIds: number[]): Map<number, ReplyHistory> {
  const result = new Map<number, ReplyHistory>();
  if (blIds.length === 0) return result;
  const rows = db
    .select({ blId: replies.blId, id: replies.id, repliedOn: replies.repliedOn, replyTypeId: replyTypes.id, typeName: replyTypes.name, code: replyTypes.code })
    .from(replies)
    .innerJoin(replyTypes, eq(replyTypes.id, replies.replyTypeId))
    .where(inArray(replies.blId, blIds))
    .all()
    .sort((a, b) => a.repliedOn.localeCompare(b.repliedOn) || a.id - b.id);
  for (const row of rows) {
    const entry = result.get(row.blId) ?? { lastAnswerOn: null, last: null };
    entry.last = { replyTypeId: row.replyTypeId, typeName: row.typeName, repliedOn: row.repliedOn };
    if (countsAsAnswer(row.code)) entry.lastAnswerOn = row.repliedOn;
    result.set(row.blId, entry);
  }
  return result;
}
