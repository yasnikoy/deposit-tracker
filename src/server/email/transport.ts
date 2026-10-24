import "server-only";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { DbOrTx } from "../db/client";
import { getEnv } from "../env";
import { logger } from "../logger";
import { getSecretSetting, getSetting } from "../settings";

export type Envelope = { from: string; to: string[] };

/** How the app talks to the mail servers; tests pass a fake. */
export type MailTransport = {
  /** True when nothing leaves the PC (rule 13): messages are only stored and logged. */
  dryRun: boolean;
  send(raw: Buffer, envelope: Envelope): Promise<void>;
  /** Puts a copy into the IMAP sent folder so it shows in Outlook. Never touches other messages. */
  appendToSent(raw: Buffer): Promise<void>;
};

const security = (value: string) => ({ secure: value === "tls", requireTLS: value === "starttls" });

/** SMTP and IMAP from the email settings; dry-run outside production unless EMAIL_MODE=live. */
export function mailTransport(db: DbOrTx): MailTransport {
  if (getEnv().EMAIL_MODE !== "live") {
    return {
      dryRun: true,
      async send(raw, envelope) {
        logger.info({ envelope, bytes: raw.length }, "dry-run: email stored, not sent");
      },
      async appendToSent() {},
    };
  }

  const auth = { user: getSetting("email.username", {}, db), pass: getSecretSetting("email.password", db) };
  const smtp = {
    host: getSetting("email.smtpHost", {}, db),
    port: getSetting("email.smtpPort", {}, db),
    ...security(getSetting("email.smtpSecurity", {}, db)),
    auth,
  };
  // ImapFlow upgrades a plain connection with STARTTLS whenever the server offers it.
  const imap = {
    host: getSetting("email.imapHost", {}, db),
    port: getSetting("email.imapPort", {}, db),
    secure: getSetting("email.imapSecurity", {}, db) === "tls",
    auth,
    logger: false as const,
  };
  const sentFolder = getSetting("email.sentFolder", {}, db);

  return {
    dryRun: false,
    async send(raw, envelope) {
      const transporter = nodemailer.createTransport(smtp);
      try {
        await transporter.sendMail({ envelope, raw });
      } finally {
        transporter.close();
      }
    },
    async appendToSent(raw) {
      const client = new ImapFlow(imap);
      await client.connect();
      try {
        // Rule 12: the only IMAP write is adding our own sent copy, marked as read.
        await client.append(sentFolder, raw, ["\\Seen"]);
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}
