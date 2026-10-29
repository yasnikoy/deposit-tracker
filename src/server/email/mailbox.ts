import "server-only";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import type { DbOrTx } from "../db/client";
import { getSecretSetting, getSetting } from "../settings";

export type MailboxMessage = { uid: number; raw: Buffer; receivedAt: Date };

/** A message found by a mailbox search, for the manual link list. */
export type MailboxSummary = { uid: number; messageId: string | null; from: string; subject: string; receivedAt: string };

/** Where the poller stopped; UIDs are only meaningful with their folder's UIDVALIDITY. */
export type MailboxCursor = { uidValidity: string; lastUid: number };

/**
 * The shared mailbox, read-only (rule 12): the folder is opened with EXAMINE, so nothing is
 * moved, deleted, flagged or marked as read. Tests pass a fake.
 */
export type Mailbox = {
  folder: string;
  /**
   * Messages after the cursor, oldest first, at most `limit`. Without a cursor (first poll,
   * or the folder's UIDVALIDITY changed) messages received since `since` are read.
   */
  readNew(cursor: MailboxCursor | null, since: Date, limit: number): Promise<{ cursor: MailboxCursor; messages: MailboxMessage[] }>;
  /** Newest first, at most `limit`. */
  search(query: { from: string; subject: string }, limit: number): Promise<{ uidValidity: string; results: MailboxSummary[] }>;
  fetch(uid: number, uidValidity: string): Promise<MailboxMessage | null>;
};

/**
 * The IMAP mailbox from the email settings, or null while it is not set up. Reading is the
 * same in dry-run and live mode: it never changes the mailbox, and only sending is held back.
 */
export function mailboxFromSettings(db: DbOrTx): Mailbox | null {
  const host = getSetting("email.imapHost", {}, db);
  const user = getSetting("email.username", {}, db);
  const pass = getSecretSetting("email.password", db);
  if (!host || !user || !pass) return null;
  const options = {
    host,
    port: getSetting("email.imapPort", {}, db),
    secure: getSetting("email.imapSecurity", {}, db) === "tls",
    auth: { user, pass },
    logger: false as const,
  };
  const folder = getSetting("email.inboxFolder", {}, db);

  async function withFolder<T>(work: (client: ImapFlow, uidValidity: string, uidNext: number) => Promise<T>): Promise<T> {
    const client = new ImapFlow(options);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const box = client.mailbox;
        if (!box) throw new Error(`Mailbox folder "${folder}" could not be opened`);
        return await work(client, String(box.uidValidity), box.uidNext);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  const toMessage = (message: FetchMessageObject): MailboxMessage | null =>
    message.source ? { uid: message.uid, raw: message.source, receivedAt: new Date(message.internalDate ?? Date.now()) } : null;

  return {
    folder,
    readNew: (cursor, since, limit) =>
      withFolder(async (client, uidValidity, uidNext) => {
        const valid = cursor?.uidValidity === uidValidity ? cursor : null;
        const found = valid ? await client.search({ uid: `${valid.lastUid + 1}:*` }, { uid: true }) : await client.search({ since }, { uid: true });
        // "N:*" always returns the newest message, even when it is older than N.
        const uids = (found || []).filter((uid) => !valid || uid > valid.lastUid).sort((a, b) => a - b);
        const batch = uids.slice(0, limit);
        const messages: MailboxMessage[] = [];
        if (batch.length > 0) {
          for await (const message of client.fetch(batch, { uid: true, source: true, internalDate: true }, { uid: true })) {
            const read = toMessage(message);
            if (read) messages.push(read);
          }
        }
        messages.sort((a, b) => a.uid - b.uid);
        const lastUid = batch.length < uids.length ? batch[batch.length - 1] : Math.max(uidNext - 1, valid?.lastUid ?? 0, ...batch);
        return { cursor: { uidValidity, lastUid }, messages };
      }),

    search: (query, limit) =>
      withFolder(async (client, uidValidity) => {
        const criteria: Record<string, string> = {};
        if (query.from) criteria.from = query.from;
        if (query.subject) criteria.subject = query.subject;
        const found = (await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || [];
        const newest = found.sort((a, b) => b - a).slice(0, limit);
        const results: MailboxSummary[] = [];
        if (newest.length > 0) {
          for await (const message of client.fetch(newest, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
            const from = message.envelope?.from?.[0];
            results.push({
              uid: message.uid,
              messageId: message.envelope?.messageId ?? null,
              from: from ? (from.name ? `${from.name} <${from.address}>` : (from.address ?? "")) : "",
              subject: message.envelope?.subject ?? "",
              receivedAt: new Date(message.internalDate ?? Date.now()).toISOString(),
            });
          }
        }
        return { uidValidity, results: results.sort((a, b) => b.uid - a.uid) };
      }),

    fetch: (uid, expectedValidity) =>
      withFolder(async (client, uidValidity) => {
        if (uidValidity !== expectedValidity) return null;
        const message = await client.fetchOne(String(uid), { uid: true, source: true, internalDate: true }, { uid: true });
        return message ? toMessage(message) : null;
      }),
  };
}
