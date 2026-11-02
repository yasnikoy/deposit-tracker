import { z } from "zod";

/**
 * Typed setting registry: keys, groups, value kinds and validation.
 * Initial values come only from seed/settings.json; this file never holds business values.
 * Groups for email, templates, notifications and lists arrive with the features that use them.
 */

export const SETTING_GROUPS = ["calendar", "durations", "rules", "email", "notifications", "reports", "reconciliation", "users", "backups"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** Editor and unit of a value. Every duration declares its day type through its kind. */
export type SettingKind =
  | "businessDays"
  | "minutes"
  | "count"
  | "megabytes"
  | "boolean"
  | "time"
  | "weekdays"
  /** One ISO weekday, 1 = Monday … 7 = Sunday. */
  | "weekday"
  | "bucketEdges"
  | "fileTypes"
  | "text"
  | "longText"
  | "emailList"
  /** Email domains such as `firma.com.tr`. */
  | "domainList"
  /** One of a fixed list of technical options (labels in tr.json under settings.choices). */
  | "choice"
  /** Stored encrypted; never sent back to the browser (rule 14). */
  | "secret";

type Definition = {
  group: SettingGroup;
  kind: SettingKind;
  schema: z.ZodType;
  /** Overridable per agency and per B/L; the agency override is stored in this column. */
  agencyColumn?: string;
  /** Options of a "choice" setting. */
  options?: readonly string[];
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const weekdays = z
  .array(int(1, 7))
  .max(6)
  .refine((days) => new Set(days).size === days.length, "duplicate weekday");

const bucketEdges = z
  .array(int(1, 3650))
  .min(1)
  .max(10)
  .refine((edges) => edges.every((edge, i) => i === 0 || edge > edges[i - 1]), "edges must ascend");

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const emailAddress = z.string().trim().toLowerCase().pipe(z.email());
const emailList = z.array(emailAddress).max(20);
const domainList = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  )
  .max(20);
const host = z.string().trim().max(253);
const port = int(1, 65535);
const MAIL_SECURITY = ["tls", "starttls", "none"] as const;

const fileTypes = z
  .array(z.string().regex(/^[a-z0-9]{1,10}$/))
  .min(1)
  .max(30);

export const settingDefinitions = {
  "calendar.weekendDays": { group: "calendar", kind: "weekdays", schema: weekdays },
  "calendar.halfDaysAreBusinessDays": { group: "calendar", kind: "boolean", schema: z.boolean() },

  "durations.firstRequestDueDays": {
    group: "durations",
    kind: "businessDays",
    schema: int(0, 365),
    agencyColumn: "first_request_due_days",
  },
  "durations.upcomingDays": { group: "durations", kind: "businessDays", schema: int(0, 60), agencyColumn: "upcoming_days" },
  "durations.followUpDays": { group: "durations", kind: "businessDays", schema: int(1, 365), agencyColumn: "follow_up_days" },
  "durations.statementRequestDays": {
    group: "durations",
    kind: "businessDays",
    schema: int(0, 365),
    agencyColumn: "statement_request_days",
  },
  "durations.statementFollowUpDays": {
    group: "durations",
    kind: "businessDays",
    schema: int(1, 365),
    agencyColumn: "statement_follow_up_days",
  },
  "durations.unprocessedReplyWarningDays": { group: "durations", kind: "businessDays", schema: int(0, 60) },
  "durations.agingBucketEdges": { group: "durations", kind: "bucketEdges", schema: bucketEdges },

  "rules.blockSendingWithoutForm": { group: "rules", kind: "boolean", schema: z.boolean() },
  "rules.duplicateWarning": { group: "rules", kind: "boolean", schema: z.boolean() },
  "rules.draftLockTimeoutMinutes": { group: "rules", kind: "minutes", schema: int(1, 1440) },
  "rules.undoWindowMinutes": { group: "rules", kind: "minutes", schema: int(1, 1440) },
  "rules.allowedFileTypes": { group: "rules", kind: "fileTypes", schema: fileTypes },
  "rules.maxFileSizeMb": { group: "rules", kind: "megabytes", schema: int(1, 100) },

  "rules.attachStandingDocuments": { group: "rules", kind: "boolean", schema: z.boolean() },

  "email.smtpHost": { group: "email", kind: "text", schema: host },
  "email.smtpPort": { group: "email", kind: "count", schema: port },
  "email.smtpSecurity": { group: "email", kind: "choice", schema: z.enum(MAIL_SECURITY), options: MAIL_SECURITY },
  "email.imapHost": { group: "email", kind: "text", schema: host },
  "email.imapPort": { group: "email", kind: "count", schema: port },
  "email.imapSecurity": { group: "email", kind: "choice", schema: z.enum(MAIL_SECURITY), options: MAIL_SECURITY },
  "email.username": { group: "email", kind: "text", schema: z.string().trim().max(254) },
  /** Encrypted app password ("" until entered). */
  "email.password": { group: "email", kind: "secret", schema: z.string().max(2000) },
  /** Sender address; empty until the mailbox is set up. */
  "email.fromAddress": { group: "email", kind: "text", schema: z.union([z.literal(""), emailAddress]) },
  "email.fromName": { group: "email", kind: "text", schema: z.string().trim().max(100) },
  "email.sentFolder": { group: "email", kind: "text", schema: z.string().trim().min(1).max(100) },
  /** The folder the poller reads agency replies from, read-only (rule 12). */
  "email.inboxFolder": { group: "email", kind: "text", schema: z.string().trim().min(1).max(100) },
  "email.pollIntervalMinutes": { group: "email", kind: "minutes", schema: int(1, 1440) },
  "email.defaultCc": { group: "email", kind: "emailList", schema: emailList },
  "email.defaultBcc": { group: "email", kind: "emailList", schema: emailList },
  "email.signature": { group: "email", kind: "longText", schema: z.string().max(2000) },
  "email.maxAttachmentMb": { group: "email", kind: "megabytes", schema: int(1, 100) },

  "notifications.dailyUnprocessedEmail": { group: "notifications", kind: "boolean", schema: z.boolean() },
  "notifications.dailyUnprocessedTime": { group: "notifications", kind: "time", schema: time },
  "notifications.dailyUnprocessedRecipients": { group: "notifications", kind: "emailList", schema: emailList },
  "notifications.weeklySummaryEmail": { group: "notifications", kind: "boolean", schema: z.boolean() },
  "notifications.weeklySummaryWeekday": { group: "notifications", kind: "weekday", schema: int(1, 7) },
  "notifications.weeklySummaryTime": { group: "notifications", kind: "time", schema: time },
  "notifications.weeklySummaryRecipients": { group: "notifications", kind: "emailList", schema: emailList },
  /** In-app notifications are always on; these choose which events notify. */
  "notifications.inAppCorrection": { group: "notifications", kind: "boolean", schema: z.boolean() },
  "notifications.inAppUnprocessedReply": { group: "notifications", kind: "boolean", schema: z.boolean() },
  "notifications.inAppWriteOff": { group: "notifications", kind: "boolean", schema: z.boolean() },
  "notifications.inAppNewAgency": { group: "notifications", kind: "boolean", schema: z.boolean() },

  /** Report email recipients must be in one of these domains (or the sender's own). */
  "reports.internalDomains": { group: "reports", kind: "domainList", schema: domainList },
  /** Prefills the report email preview. */
  "reports.defaultRecipients": { group: "reports", kind: "emailList", schema: emailList },

  "reconciliation.alternativeSuggestions": { group: "reconciliation", kind: "count", schema: int(1, 10) },

  /** Failed logins before an account is locked; 0 disables lockout. */
  "auth.loginLockoutAttempts": { group: "users", kind: "count", schema: int(0, 100) },
  "auth.minPasswordLength": { group: "users", kind: "count", schema: int(4, 128) },

  "backups.dailyTime": { group: "backups", kind: "time", schema: time },
  "backups.keepDaily": { group: "backups", kind: "count", schema: int(1, 365) },
  "backups.keepWeekly": { group: "backups", kind: "count", schema: int(0, 260) },
  /** Folder for the second backup copy; empty until IT provides one. */
  "backups.secondLocation": { group: "backups", kind: "text", schema: z.string().trim().max(260) },
} as const satisfies Record<string, Definition>;

export type SettingKey = keyof typeof settingDefinitions;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingDefinitions)[K]["schema"]>;

export const SETTING_KEYS = Object.keys(settingDefinitions) as SettingKey[];

export type OverridableSettingKey = {
  [K in SettingKey]: (typeof settingDefinitions)[K] extends { agencyColumn: string } ? K : never;
}[SettingKey];

export const OVERRIDABLE_SETTING_KEYS = SETTING_KEYS.filter(
  (key): key is OverridableSettingKey => "agencyColumn" in settingDefinitions[key],
);

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingDefinitions, key);
}

export function isOverridableSettingKey(key: string): key is OverridableSettingKey {
  return (OVERRIDABLE_SETTING_KEYS as string[]).includes(key);
}

export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingDefinitions[key].schema.parse(value) as SettingValue<K>;
}

export function isSecretSetting(key: SettingKey): boolean {
  return settingDefinitions[key].kind === "secret";
}
