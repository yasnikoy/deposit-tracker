/**
 * @mentions in B/L notes. A mention is `@` plus a username (letters, digits, `.`, `_`, `-`;
 * 2–64 characters) that does not follow a letter or digit, so email addresses never count.
 */

const MENTION = /(?<![\p{L}\p{N}._-])@([A-Za-z0-9._-]{2,64})/gu;

/** Usernames mentioned in a text, lower-cased, in order of first appearance. */
export function mentionedUsernames(text: string): string[] {
  const names = [...text.matchAll(MENTION)].map((m) => m[1].replace(/[.\-_]+$/, "").toLowerCase()).filter((name) => name.length >= 2);
  return [...new Set(names)];
}
