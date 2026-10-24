import "server-only";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { EMAIL_TEMPLATE_KEYS, type EmailTemplateKey } from "@/domain/email-templates";
import { writeAudit } from "../audit";
import { authorize } from "../auth/can";
import type { AuthUser } from "../auth/types";
import type { Db, DbOrTx } from "../db/client";
import { emailTemplates } from "../db/schema";
import { DomainError } from "../errors";
import { SEED_FILE } from "../settings";

export type EmailTemplate = typeof emailTemplates.$inferSelect;

/** Inserts seed templates missing from the database; edited templates are never touched. */
export function seedEmailTemplates(db: Db, seedFile: string = SEED_FILE, now: Date = new Date()): EmailTemplateKey[] {
  const seed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ seedFile, "utf8")) as {
    emailTemplates?: Partial<Record<EmailTemplateKey, { subject: string; body: string }>>;
  };
  const inserted: EmailTemplateKey[] = [];
  db.transaction((tx) => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const template = seed.emailTemplates?.[key];
      if (!template) throw new Error(`Email template "${key}" is missing from the seed file`);
      if (tx.select({ key: emailTemplates.key }).from(emailTemplates).where(eq(emailTemplates.key, key)).get()) continue;
      tx.insert(emailTemplates).values({ key, ...template, updatedAt: now.toISOString(), updatedBy: null }).run();
      writeAudit(tx, { actorUserId: null, roleUsed: null, action: "emailTemplate.seed", entityType: "email_template", entityId: key, after: template }, now);
      inserted.push(key);
    }
  });
  return inserted;
}

export function getEmailTemplate(db: DbOrTx, key: EmailTemplateKey): EmailTemplate {
  const row = db.select().from(emailTemplates).where(eq(emailTemplates.key, key)).get();
  if (!row) throw new Error(`Email template "${key}" is missing; was the seed loaded?`);
  return row;
}

export function listEmailTemplates(db: DbOrTx, actor: AuthUser): EmailTemplate[] {
  authorize(actor, "settings.view");
  return EMAIL_TEMPLATE_KEYS.map((key) => getEmailTemplate(db, key));
}

/** Templates are settings: admin only, with history in the audit log. */
export function updateEmailTemplate(
  db: Db,
  actor: AuthUser,
  input: { key: EmailTemplateKey; subject: string; body: string; reason: string | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "settings.update");
  db.transaction((tx) => {
    const before = getEmailTemplate(tx, input.key);
    if (before.subject === input.subject && before.body === input.body) throw new DomainError("settings.noChanges");
    tx.update(emailTemplates)
      .set({ subject: input.subject, body: input.body, updatedAt: now.toISOString(), updatedBy: actor.id })
      .where(eq(emailTemplates.key, input.key))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "emailTemplate.update",
        entityType: "email_template",
        entityId: input.key,
        before: { subject: before.subject, body: before.body },
        after: { subject: input.subject, body: input.body },
        reason: input.reason,
      },
      now,
    );
  });
}
