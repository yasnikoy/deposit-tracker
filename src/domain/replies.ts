/**
 * Agency replies. The app never interprets a reply: a user records its type per B/L. The
 * system reply types carry the only behaviour; types an admin adds only document the answer.
 */

export const REPLY_TYPE_CODES = ["NOT_RETURNED", "APPROVED", "STATEMENT_RECEIVED", "INFO"] as const;
export type ReplyTypeCode = (typeof REPLY_TYPE_CODES)[number];

/**
 * Whether a reply of this type restarts the follow-up clock. An info-only reply (auto-reply,
 * "we received your request") is processed but counts as no answer.
 */
export function countsAsAnswer(code: ReplyTypeCode | null): boolean {
  return code !== "INFO";
}
