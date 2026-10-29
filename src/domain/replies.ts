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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The B/L numbers that occur in a text as whole tokens, case-insensitively, in the order of
 * the given list. "MEDU123" does not match inside "MEDU1234" or "XMEDU123".
 */
export function findBlNumbers(text: string, blNos: readonly string[]): string[] {
  const upper = text.toUpperCase();
  return blNos.filter((blNo) => {
    const needle = blNo.toUpperCase();
    if (!upper.includes(needle)) return false;
    return new RegExp(`(^|[^A-Z0-9])${escape(needle)}($|[^A-Z0-9])`).test(upper);
  });
}
