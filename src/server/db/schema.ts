import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { REQUEST_CHANNELS } from "../../domain/agency";
import { HOLIDAY_KINDS } from "../../domain/business-days";
import { EMAIL_TEMPLATE_KEYS } from "../../domain/email-templates";
import { NOTIFICATION_KINDS } from "../../domain/notifications";
import { REPLY_TYPE_CODES } from "../../domain/replies";
import {
  BL_STATUSES,
  DOCUMENT_KINDS,
  EMAIL_DIRECTIONS,
  EMAIL_LINK_SOURCES,
  JOB_KINDS,
  JOB_STATUSES,
  LEDGER_TYPES,
  MAIL_SERVICES,
  PAYMENT_KINDS,
  REQUEST_TYPES,
  SEND_STATUSES,
  STANDING_DOCUMENT_SLOTS,
  SUGGESTION_STATES,
  ALLOCATION_STATES,
  DEDUCTION_SOURCES,
  DEDUCTION_TYPE_CODES,
  WRITE_OFF_STATES,
} from "../../domain/records";
import { ROLES } from "../../domain/roles";

// Event timestamps are UTC ISO-8601 text; business dates are YYYY-MM-DD text.
const timestamp = (name: string) => text(name);
const roleList = sql.raw(ROLES.map((r) => `'${r}'`).join(", "));

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedAt: timestamp("locked_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_username_unique").on(sql`lower(${t.username})`),
    check("users_username_format", sql`${t.username} NOT GLOB '*[^A-Za-z0-9._-]*' AND length(${t.username}) BETWEEN 2 AND 64`),
    check("users_failed_login_count", sql`${t.failedLoginCount} >= 0`),
  ],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ROLES }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] }), check("user_roles_role", sql`${t.role} IN (${roleList})`)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 of the cookie token; the raw token is never stored.
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("sessions_user_id").on(t.userId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: timestamp("at").notNull(),
    // Null actor means the system (scheduler, startup tasks, create-admin script).
    actorUserId: integer("actor_user_id").references(() => users.id),
    roleUsed: text("role_used", { enum: ROLES }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    reason: text("reason"),
    undoOf: integer("undo_of").references((): AnySQLiteColumn => auditLog.id),
  },
  (t) => [
    index("audit_log_entity").on(t.entityType, t.entityId),
    index("audit_log_actor").on(t.actorUserId),
    check("audit_log_role_used", sql`${t.roleUsed} IS NULL OR ${t.roleUsed} IN (${roleList})`),
  ],
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// Global settings. Agency and B/L overrides live on their own tables (step 2).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
});

export const settingsHistory = sqliteTable(
  "settings_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(),
    oldValue: text("old_value", { mode: "json" }),
    newValue: text("new_value", { mode: "json" }).notNull(),
    changedBy: integer("changed_by").references(() => users.id),
    changedAt: timestamp("changed_at").notNull(),
    reason: text("reason"),
  },
  (t) => [index("settings_history_key").on(t.key)],
);

export const holidays = sqliteTable(
  "holidays",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: HOLIDAY_KINDS }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("holidays_date_unique").on(t.date),
    check("holidays_kind", sql`${t.kind} IN ('FULL', 'HALF')`),
    check("holidays_date_format", sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  ],
);

const overrideDays = (name: string) => integer(name);

export const agencies = sqliteTable(
  "agencies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    // One recipient list for all request types.
    toRecipients: text("to_recipients", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    ccRecipients: text("cc_recipients", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    bankSenderAliases: text("bank_sender_aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    blNumberPatterns: text("bl_number_patterns", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    batchSending: integer("batch_sending", { mode: "boolean" }).notNull().default(false),
    requestChannel: text("request_channel", { enum: REQUEST_CHANNELS }).notNull().default("EMAIL"),
    portalUrl: text("portal_url"),
    // The agency's refund request form (.docx with placeholders), uploaded by an admin.
    formTemplateDocumentId: integer("form_template_document_id").references((): AnySQLiteColumn => documents.id),
    notes: text("notes"),
    // Setting overrides (null inherits the global value); column names match the setting registry.
    firstRequestDueDays: overrideDays("first_request_due_days"),
    upcomingDays: overrideDays("upcoming_days"),
    followUpDays: overrideDays("follow_up_days"),
    statementRequestDays: overrideDays("statement_request_days"),
    statementFollowUpDays: overrideDays("statement_follow_up_days"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("agencies_name_unique").on(sql`lower(${t.name})`),
    check("agencies_request_channel", sql`${t.requestChannel} IN ('EMAIL', 'PORTAL')`),
    check("agencies_portal_url", sql`${t.requestChannel} <> 'PORTAL' OR ${t.portalUrl} IS NOT NULL`),
    check(
      "agencies_overrides_non_negative",
      sql`coalesce(${t.firstRequestDueDays}, 0) >= 0 AND coalesce(${t.upcomingDays}, 0) >= 0
        AND coalesce(${t.followUpDays}, 1) >= 1 AND coalesce(${t.statementRequestDays}, 0) >= 0
        AND coalesce(${t.statementFollowUpDays}, 1) >= 1`,
    ),
  ],
);

// ---- Build step 3: lists, documents, payments, B/Ls, ledger ----

const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** Void columns: all three set together, or none (rule 15). */
const voidColumns = () => ({
  voidedAt: timestamp("voided_at"),
  voidedBy: integer("voided_by").references(() => users.id),
  voidReason: text("void_reason"),
});
const voidCheck = (name: string, t: { voidedAt: AnySQLiteColumn; voidedBy: AnySQLiteColumn; voidReason: AnySQLiteColumn }) =>
  check(
    name,
    sql`(${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL AND ${t.voidReason} IS NULL)
      OR (${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL AND length(trim(${t.voidReason})) > 0)`,
  );

export const currencies = sqliteTable(
  "currencies",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    minorUnitDigits: integer("minor_unit_digits").notNull().default(2),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    check("currencies_code", sql`${t.code} GLOB '[A-Z][A-Z][A-Z]'`),
    // v1 money handling assumes cents.
    check("currencies_minor_unit_digits", sql`${t.minorUnitDigits} = 2`),
  ],
);

// Our own accounts, used to fill {bank_name} / {iban} in agency refund forms.
export const bankAccounts = sqliteTable(
  "bank_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    bankName: text("bank_name").notNull(),
    iban: text("iban").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [uniqueIndex("bank_accounts_iban_unique").on(t.iban)],
);

export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    // Set when the file is attached to a record; uploads waiting in a form or queue have none yet.
    ownerType: text("owner_type"),
    ownerId: integer("owner_id"),
    originalName: text("original_name").notNull(),
    // Relative to the data folder's files directory.
    storedPath: text("stored_path").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    // Null for files the app imported from the mailbox (email attachments, raw messages).
    uploadedBy: integer("uploaded_by").references(() => users.id),
    uploadedAt: timestamp("uploaded_at").notNull(),
    // An undone upload (rule 17): the file stays, but no longer counts (e.g. as the current form).
    withdrawnAt: timestamp("withdrawn_at"),
    withdrawnBy: integer("withdrawn_by").references(() => users.id),
  },
  (t) => [
    check("documents_kind", sql`${t.kind} IN (${sqlList(DOCUMENT_KINDS)})`),
    check("documents_withdrawn", sql`(${t.withdrawnAt} IS NULL) = (${t.withdrawnBy} IS NULL)`),
    check("documents_owner", sql`(${t.ownerType} IS NULL) = (${t.ownerId} IS NULL)`),
    check("documents_size", sql`${t.sizeBytes} > 0`),
    uniqueIndex("documents_stored_path_unique").on(t.storedPath),
    index("documents_owner").on(t.ownerType, t.ownerId),
  ],
);

export const depositPayments = sqliteTable(
  "deposit_payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agencyId: integer("agency_id")
      .notNull()
      .references(() => agencies.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    paidAt: text("paid_at").notNull(),
    kind: text("kind", { enum: PAYMENT_KINDS }).notNull(),
    // The receipt (bank) or invoice (offset); may follow later, until then requests warn (rule 12).
    evidenceDocumentId: integer("evidence_document_id").references(() => documents.id),
    extractedFields: text("extracted_fields", { mode: "json" }).$type<Record<string, unknown>>(),
    extractedBlNumbers: text("extracted_bl_numbers", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    blNoHint: text("bl_no_hint"),
    // An additional deposit ("ek depozito") on a B/L that already exists; the B/L's first
    // payment is the one the B/L points to (bills_of_lading.deposit_payment_id).
    additionalToBlId: integer("additional_to_bl_id").references((): AnySQLiteColumn => billsOfLading.id),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ...voidColumns(),
  },
  (t) => [
    check("deposit_payments_amount", sql`${t.amountMinor} > 0`),
    index("deposit_payments_additional").on(t.additionalToBlId),
    check("deposit_payments_kind", sql`${t.kind} IN ('BANK', 'OFFSET')`),
    check("deposit_payments_paid_at", sql`${t.paidAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    voidCheck("deposit_payments_void", t),
    uniqueIndex("deposit_payments_evidence_unique").on(t.evidenceDocumentId),
    index("deposit_payments_duplicate_lookup").on(t.agencyId, t.paidAt, t.amountMinor),
  ],
);

export const receiptQueue = sqliteTable(
  "receipt_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id),
    extracted: text("extracted", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    resolution: text("resolution", { enum: ["SAVED", "DISCARDED"] }),
    paymentId: integer("payment_id").references(() => depositPayments.id),
  },
  (t) => [
    uniqueIndex("receipt_queue_document_unique").on(t.documentId),
    check(
      "receipt_queue_resolution",
      sql`(${t.resolvedAt} IS NULL AND ${t.resolution} IS NULL AND ${t.paymentId} IS NULL)
        OR (${t.resolution} = 'DISCARDED' AND ${t.resolvedAt} IS NOT NULL AND ${t.paymentId} IS NULL)
        OR (${t.resolution} = 'SAVED' AND ${t.resolvedAt} IS NOT NULL AND ${t.paymentId} IS NOT NULL)`,
    ),
  ],
);

export const billsOfLading = sqliteTable(
  "bills_of_lading",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blNo: text("bl_no").notNull(),
    // Null only for migrated records with an OPENING_BALANCE ledger entry (build step 6).
    depositPaymentId: integer("deposit_payment_id").references(() => depositPayments.id),
    agencyId: integer("agency_id")
      .notNull()
      .references(() => agencies.id),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    depositAmountMinor: integer("deposit_amount_minor").notNull(),
    paidAt: text("paid_at").notNull(),
    // DUE is computed on read and never stored.
    status: text("status", { enum: BL_STATUSES }).notNull(),
    // Setting overrides (null inherits the agency, then the global value).
    firstRequestDueDays: overrideDays("first_request_due_days"),
    upcomingDays: overrideDays("upcoming_days"),
    followUpDays: overrideDays("follow_up_days"),
    statementRequestDays: overrideDays("statement_request_days"),
    statementFollowUpDays: overrideDays("statement_follow_up_days"),
    // Draft lock (rule 14): set while a user prepares a request email for this B/L.
    lockedBy: integer("locked_by").references(() => users.id),
    lockedAt: timestamp("locked_at"),
    // The importer we paid the deposit for, and our internal file number (e.g. T26-90815).
    customerId: integer("customer_id").references((): AnySQLiteColumn => customers.id),
    fileNo: text("file_no"),
    // Free text kept by accounting and operations ("Açıklama"); replaced the team notes.
    description: text("description"),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ...voidColumns(),
  },
  (t) => [
    check("bills_of_lading_amount", sql`${t.depositAmountMinor} > 0`),
    index("bills_of_lading_customer").on(t.customerId),
    check("bills_of_lading_status", sql`${t.status} IN (${sqlList(BL_STATUSES.filter((s) => s !== "DUE"))})`),
    voidCheck("bills_of_lading_void", t),
    check(
      "bills_of_lading_overrides_non_negative",
      sql`coalesce(${t.firstRequestDueDays}, 0) >= 0 AND coalesce(${t.upcomingDays}, 0) >= 0
        AND coalesce(${t.followUpDays}, 1) >= 1 AND coalesce(${t.statementRequestDays}, 0) >= 0
        AND coalesce(${t.statementFollowUpDays}, 1) >= 1`,
    ),
    // Rule 11: at most one active B/L per payment record.
    uniqueIndex("bills_of_lading_payment_active")
      .on(t.depositPaymentId)
      .where(sql`${t.voidedAt} IS NULL AND ${t.depositPaymentId} IS NOT NULL`),
    uniqueIndex("bills_of_lading_bl_no_active").on(sql`upper(${t.blNo})`).where(sql`${t.voidedAt} IS NULL`),
    index("bills_of_lading_agency").on(t.agencyId),
  ],
);

export const containers = sqliteTable(
  "containers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    containerNo: text("container_no").notNull(),
    type: text("type"),
  },
  (t) => [uniqueIndex("containers_bl_container_unique").on(t.blId, t.containerNo)],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    type: text("type", { enum: LEDGER_TYPES }).notNull(),
    // Signed: a compensating entry carries the negated amount of the entry it cancels.
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    entryDate: text("entry_date").notNull(),
    depositPaymentId: integer("deposit_payment_id").references(() => depositPayments.id),
    compensatesEntryId: integer("compensates_entry_id").references((): AnySQLiteColumn => ledgerEntries.id),
    // REFUND_ALLOCATION entries, and the shortfall deduction confirmed with an allocation.
    refundAllocationId: integer("refund_allocation_id").references((): AnySQLiteColumn => refundAllocations.id),
    // DEDUCTION entries only.
    deductionTypeId: integer("deduction_type_id").references((): AnySQLiteColumn => deductionTypes.id),
    deductionSource: text("deduction_source", { enum: DEDUCTION_SOURCES }),
    // The agency's deduction statement: mandatory for STATEMENT deductions, optional when a shortfall is classified.
    documentId: integer("document_id").references(() => documents.id),
    // Set once when operations disputes an unexplained deduction; never cleared, the entry is compensated instead.
    disputed: integer("disputed", { mode: "boolean" }).notNull().default(false),
    disputeNote: text("dispute_note"),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    check("ledger_entries_type", sql`${t.type} IN (${sqlList(LEDGER_TYPES)})`),
    check("ledger_entries_statement_document", sql`${t.deductionSource} IS NOT 'STATEMENT' OR ${t.documentId} IS NOT NULL`),
    check(
      "ledger_entries_dispute",
      sql`(${t.disputed} = 0 AND ${t.disputeNote} IS NULL)
        OR (${t.disputed} = 1 AND ${t.type} = 'DEDUCTION' AND ${t.compensatesEntryId} IS NULL AND length(trim(${t.disputeNote})) > 0)`,
    ),
    check(
      "ledger_entries_deduction",
      sql`(${t.type} = 'DEDUCTION') = (${t.deductionTypeId} IS NOT NULL AND ${t.deductionSource} IN (${sqlList(DEDUCTION_SOURCES)}))`,
    ),
    check("ledger_entries_allocation", sql`${t.type} <> 'REFUND_ALLOCATION' OR ${t.refundAllocationId} IS NOT NULL`),
    check("ledger_entries_amount", sql`${t.amountMinor} <> 0`),
    // An entry is compensated at most once.
    uniqueIndex("ledger_entries_compensates_unique")
      .on(t.compensatesEntryId)
      .where(sql`${t.compensatesEntryId} IS NOT NULL`),
    index("ledger_entries_bl").on(t.blId),
  ],
);

// ---- Build step 4: request cycles ----

export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    type: text("type", { enum: REQUEST_TYPES }).notNull(),
    channel: text("channel", { enum: REQUEST_CHANNELS }).notNull(),
    attemptNo: integer("attempt_no").notNull(),
    sendStatus: text("send_status", { enum: SEND_STATUSES }).notNull(),
    // Business date the request counts from: the send date, or the filing date on a portal.
    requestedOn: text("requested_on"),
    sentAt: timestamp("sent_at"),
    // The email that carries this request; null for portal requests.
    emailId: integer("email_id").references((): AnySQLiteColumn => emails.id),
    failureReason: text("failure_reason"),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    check("requests_type", sql`${t.type} IN (${sqlList(REQUEST_TYPES)})`),
    check("requests_channel", sql`${t.channel} IN ('EMAIL', 'PORTAL')`),
    check("requests_send_status", sql`${t.sendStatus} IN (${sqlList(SEND_STATUSES)})`),
    check("requests_attempt_no", sql`${t.attemptNo} >= 1`),
    check(
      "requests_sent",
      sql`(${t.sendStatus} = 'SENT') = (${t.requestedOn} IS NOT NULL AND ${t.sentAt} IS NOT NULL)`,
    ),
    check("requests_requested_on", sql`${t.requestedOn} IS NULL OR ${t.requestedOn} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    // Portal requests recorded after filing (before they went with the documents email) are never queued or failed.
    check("requests_portal_sent", sql`${t.channel} <> 'PORTAL' OR ${t.sendStatus} = 'SENT'`),
    // One live request per attempt; a failed send may be retried under the same attempt number.
    uniqueIndex("requests_attempt_unique")
      .on(t.blId, t.type, t.attemptNo)
      .where(sql`${t.sendStatus} <> 'FAILED'`),
    index("requests_bl").on(t.blId),
  ],
);

// ---- Build step 4: email ----

export const emailTemplates = sqliteTable("email_templates", {
  key: text("key", { enum: EMAIL_TEMPLATE_KEYS }).primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
});

/** Outgoing request emails (and, from build step 5, imported replies). */
export const emails = sqliteTable(
  "emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    direction: text("direction", { enum: EMAIL_DIRECTIONS }).notNull(),
    agencyId: integer("agency_id").references(() => agencies.id),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    fromAddress: text("from_address").notNull(),
    to: text("to", { mode: "json" }).$type<string[]>().notNull(),
    cc: text("cc", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    bcc: text("bcc", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    subject: text("subject").notNull(),
    // The body as actually sent, not the template.
    bodyText: text("body_text").notNull(),
    // Outgoing only.
    sendStatus: text("send_status", { enum: SEND_STATUSES }),
    // Rule 13: stored and logged but never handed to the SMTP server.
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    sendAttempts: integer("send_attempts").notNull().default(0),
    lastError: text("last_error"),
    queuedBy: integer("queued_by").references(() => users.id),
    roleUsed: text("role_used"),
    sentAt: timestamp("sent_at"),
    copiedToSentAt: timestamp("copied_to_sent_at"),
    rawDocumentId: integer("raw_document_id").references(() => documents.id),
    // Incoming only: when the mailbox received the message.
    receivedAt: timestamp("received_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    check("emails_direction", sql`${t.direction} IN ('OUT', 'IN')`),
    check("emails_send_status", sql`(${t.direction} = 'OUT') = (${t.sendStatus} IS NOT NULL)`),
    check("emails_received_at", sql`(${t.direction} = 'IN') = (${t.receivedAt} IS NOT NULL)`),
    uniqueIndex("emails_message_id_unique").on(t.messageId),
    index("emails_in_reply_to").on(t.inReplyTo),
  ],
);

export const emailAttachments = sqliteTable(
  "email_attachments",
  {
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id),
  },
  (t) => [primaryKey({ columns: [t.emailId, t.documentId] })],
);

/** Signature circular and power of attorney; the newest upload per slot is attached to requests. */
export const standingDocuments = sqliteTable(
  "standing_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slot: text("slot", { enum: STANDING_DOCUMENT_SLOTS }).notNull(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id),
    uploadedBy: integer("uploaded_by")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at").notNull(),
  },
  (t) => [
    check("standing_documents_slot", sql`${t.slot} IN (${sqlList(STANDING_DOCUMENT_SLOTS)})`),
    uniqueIndex("standing_documents_document_unique").on(t.documentId),
  ],
);

/** In-process scheduler queue; overdue jobs run once at start. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    runAt: timestamp("run_at").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check("jobs_kind", sql`${t.kind} IN (${sqlList(JOB_KINDS)})`),
    check("jobs_status", sql`${t.status} IN (${sqlList(JOB_STATUSES)})`),
    index("jobs_due").on(t.status, t.runAt),
  ],
);

/** Mail server reachability, for the outage banner. */
export const serviceStatus = sqliteTable(
  "service_status",
  {
    service: text("service", { enum: MAIL_SERVICES }).primaryKey(),
    failingSince: timestamp("failing_since"),
    lastError: text("last_error"),
    lastOkAt: timestamp("last_ok_at"),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [check("service_status_service", sql`${t.service} IN (${sqlList(MAIL_SERVICES)})`)],
);

// ---- Build step 5: agency replies ----

/** Configurable reply types; the system ones (with a code) can be renamed but not removed. */
export const replyTypes = sqliteTable(
  "reply_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code", { enum: REPLY_TYPE_CODES }),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check("reply_types_code", sql`${t.code} IS NULL OR ${t.code} IN (${sqlList(REPLY_TYPE_CODES)})`),
    // System types stay usable.
    check("reply_types_system_active", sql`${t.code} IS NULL OR ${t.active} = 1`),
    uniqueIndex("reply_types_code_unique").on(t.code).where(sql`${t.code} IS NOT NULL`),
    uniqueIndex("reply_types_name_unique").on(sql`lower(${t.name})`),
  ],
);

/** Incoming emails and the B/Ls they concern (outgoing emails reach their B/Ls through requests). */
export const emailBlLinks = sqliteTable(
  "email_bl_links",
  {
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    linkedBy: text("linked_by", { enum: EMAIL_LINK_SOURCES }).notNull(),
    // Null for thread links, which the mailbox poller makes.
    linkedByUser: integer("linked_by_user").references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    // An undone link by hand (rule 17); linking the pair again clears it.
    unlinkedAt: timestamp("unlinked_at"),
    unlinkedBy: integer("unlinked_by").references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.emailId, t.blId] }),
    check("email_bl_links_unlinked", sql`(${t.unlinkedAt} IS NULL) = (${t.unlinkedBy} IS NULL) AND (${t.unlinkedAt} IS NULL OR ${t.linkedBy} <> 'THREAD')`),
    check("email_bl_links_linked_by", sql`${t.linkedBy} IN (${sqlList(EMAIL_LINK_SOURCES)})`),
    check("email_bl_links_user", sql`(${t.linkedBy} = 'THREAD') = (${t.linkedByUser} IS NULL)`),
    index("email_bl_links_bl").on(t.blId),
  ],
);

/** An incoming email outside a known thread that names an open B/L; linked only on acceptance. */
export const emailMatchSuggestions = sqliteTable(
  "email_match_suggestions",
  {
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    state: text("state", { enum: SUGGESTION_STATES }).notNull().default("OPEN"),
    resolvedBy: integer("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.emailId, t.blId] }),
    check("email_match_suggestions_state", sql`${t.state} IN (${sqlList(SUGGESTION_STATES)})`),
    check(
      "email_match_suggestions_resolved",
      sql`(${t.state} = 'OPEN') = (${t.resolvedBy} IS NULL AND ${t.resolvedAt} IS NULL)`,
    ),
  ],
);

/**
 * An agency's answer for one B/L, recorded by operations: from an incoming email (one per
 * email and B/L), or without one, e.g. read on a portal.
 */
export const replies = sqliteTable(
  "replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    replyTypeId: integer("reply_type_id")
      .notNull()
      .references(() => replyTypes.id),
    // Business date of the answer: the day the email arrived, or the date the user gives.
    repliedOn: text("replied_on").notNull(),
    emailId: integer("email_id").references(() => emails.id),
    note: text("note"),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    roleUsed: text("role_used", { enum: ROLES }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    // An undone reply (rule 17) stays in the history but counts for nothing.
    undoneAt: timestamp("undone_at"),
    undoneBy: integer("undone_by").references(() => users.id),
  },
  (t) => [
    check("replies_replied_on", sql`${t.repliedOn} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("replies_role_used", sql`${t.roleUsed} IN (${roleList})`),
    check("replies_undone", sql`(${t.undoneAt} IS NULL) = (${t.undoneBy} IS NULL)`),
    uniqueIndex("replies_email_bl_unique").on(t.emailId, t.blId).where(sql`${t.emailId} IS NOT NULL AND ${t.undoneAt} IS NULL`),
    index("replies_bl").on(t.blId),
  ],
);

/** How far the poller has read each folder; UIDs are only valid with their UIDVALIDITY. */
export const mailboxState = sqliteTable("mailbox_state", {
  folder: text("folder").primaryKey(),
  uidValidity: text("uid_validity").notNull(),
  lastUid: integer("last_uid").notNull(),
  lastPolledAt: timestamp("last_polled_at").notNull(),
});

// ---- Build step 6: refunds, allocations, deductions ----

/** Configurable deduction types; the system ones (with a code) can be renamed but never removed. */
export const deductionTypes = sqliteTable(
  "deduction_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code", { enum: DEDUCTION_TYPE_CODES }),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check("deduction_types_code", sql`${t.code} IS NULL OR ${t.code} IN (${sqlList(DEDUCTION_TYPE_CODES)})`),
    check("deduction_types_system_active", sql`${t.code} IS NULL OR ${t.active} = 1`),
    uniqueIndex("deduction_types_code_unique").on(t.code).where(sql`${t.code} IS NOT NULL`),
    uniqueIndex("deduction_types_name_unique").on(sql`lower(${t.name})`),
  ],
);

/**
 * Incoming money (accountant, rule 7); its receipt or invoice is optional and can be attached
 * later (rule 12). Its status and
 * unallocated remainder are computed from confirmed allocations, never stored (rule 3).
 */
export const refunds = sqliteTable(
  "refunds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agencyId: integer("agency_id")
      .notNull()
      .references(() => agencies.id),
    // The one customer a refund is for (required for new refunds; null on refunds entered before v0.10.0).
    customerId: integer("customer_id").references((): AnySQLiteColumn => customers.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    valueDate: text("value_date").notNull(),
    kind: text("kind", { enum: PAYMENT_KINDS }).notNull(),
    evidenceDocumentId: integer("evidence_document_id").references(() => documents.id),
    // Set when operations leaves the remainder unallocated on purpose (e.g. an overpayment).
    unallocatedReason: text("unallocated_reason"),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ...voidColumns(),
  },
  (t) => [
    check("refunds_amount", sql`${t.amountMinor} > 0`),
    check("refunds_kind", sql`${t.kind} IN ('BANK', 'OFFSET')`),
    check("refunds_value_date", sql`${t.valueDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("refunds_unallocated_reason", sql`${t.unallocatedReason} IS NULL OR length(trim(${t.unallocatedReason})) > 0`),
    voidCheck("refunds_void", t),
    uniqueIndex("refunds_evidence_unique").on(t.evidenceDocumentId),
    index("refunds_duplicate_lookup").on(t.agencyId, t.valueDate, t.amountMinor),
    index("refunds_customer").on(t.customerId),
  ],
);

/** A confirmed split of a refund over a B/L; its money also lands as a REFUND_ALLOCATION ledger entry. */
export const refundAllocations = sqliteTable(
  "refund_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    refundId: integer("refund_id")
      .notNull()
      .references(() => refunds.id),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    amountMinor: integer("amount_minor").notNull(),
    state: text("state", { enum: ALLOCATION_STATES }).notNull().default("CONFIRMED"),
    // The B/L status before this allocation, restored when an admin reverses it.
    blStatusBefore: text("bl_status_before", { enum: BL_STATUSES }).notNull(),
    confirmedBy: integer("confirmed_by")
      .notNull()
      .references(() => users.id),
    roleUsed: text("role_used", { enum: ROLES }).notNull(),
    confirmedAt: timestamp("confirmed_at").notNull(),
    reversedBy: integer("reversed_by").references(() => users.id),
    reversedAt: timestamp("reversed_at"),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    check("refund_allocations_amount", sql`${t.amountMinor} > 0`),
    check("refund_allocations_state", sql`${t.state} IN (${sqlList(ALLOCATION_STATES)})`),
    check(
      "refund_allocations_reversal",
      sql`(${t.state} = 'REVERSED') = (${t.reversedBy} IS NOT NULL AND ${t.reversedAt} IS NOT NULL AND length(trim(${t.reversalReason})) > 0)`,
    ),
    check("refund_allocations_role_used", sql`${t.roleUsed} IN (${roleList})`),
    uniqueIndex("refund_allocations_confirmed_unique").on(t.refundId, t.blId).where(sql`${t.state} = 'CONFIRMED'`),
    index("refund_allocations_bl").on(t.blId),
  ],
);

/**
 * Rule 16: operations proposes writing off what a B/L will not recover, with a reason; an
 * admin approves (a WRITE_OFF deduction closes the B/L) or rejects it. Unapproved, it
 * changes nothing.
 */
export const writeOffs = sqliteTable(
  "write_offs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blId: integer("bl_id")
      .notNull()
      .references(() => billsOfLading.id),
    // What the B/L still lacked when proposed; approval requires it to be unchanged.
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    reason: text("reason").notNull(),
    state: text("state", { enum: WRITE_OFF_STATES }).notNull().default("PROPOSED"),
    proposedBy: integer("proposed_by")
      .notNull()
      .references(() => users.id),
    proposedAt: timestamp("proposed_at").notNull(),
    decidedBy: integer("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at"),
    // Rejections need a reason; an approval may carry a note.
    decisionNote: text("decision_note"),
    // The WRITE_OFF deduction written on approval.
    ledgerEntryId: integer("ledger_entry_id").references(() => ledgerEntries.id),
  },
  (t) => [
    check("write_offs_amount", sql`${t.amountMinor} > 0`),
    check("write_offs_reason", sql`length(trim(${t.reason})) > 0`),
    check("write_offs_state", sql`${t.state} IN (${sqlList(WRITE_OFF_STATES)})`),
    check(
      "write_offs_decision",
      sql`(${t.state} = 'PROPOSED' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL AND ${t.ledgerEntryId} IS NULL)
        OR (${t.state} = 'APPROVED' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.ledgerEntryId} IS NOT NULL)
        OR (${t.state} = 'REJECTED' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.ledgerEntryId} IS NULL
          AND length(trim(${t.decisionNote})) > 0)`,
    ),
    // One open proposal per B/L.
    uniqueIndex("write_offs_proposed_unique").on(t.blId).where(sql`${t.state} = 'PROPOSED'`),
    index("write_offs_bl").on(t.blId),
  ],
);

// ---- Build step 7: report email ----

/**
 * An operations report sent to internal addresses: the outgoing email (sent through the
 * request send job) with the sections and filters it was built from.
 */
export const reportEmails = sqliteTable("report_emails", {
  emailId: integer("email_id")
    .primaryKey()
    .references(() => emails.id),
  sections: text("sections", { mode: "json" }).$type<string[]>().notNull(),
  filters: text("filters", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

/** In-app notifications; `detail` keeps what the text needs as it was when the event happened. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, string | number | null>>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    readAt: timestamp("read_at"),
  },
  (t) => [
    check("notifications_kind", sql`${t.kind} IN (${sqlList(NOTIFICATION_KINDS)})`),
    // An overdue reply notifies each user once.
    uniqueIndex("notifications_unprocessed_once").on(t.userId, t.entityId).where(sql`${t.kind} = 'UNPROCESSED_REPLY'`),
    index("notifications_user").on(t.userId, t.readAt),
  ],
);

/** Importers we pay deposits for (e.g. Ornek Enerji); chosen on each B/L. Deactivated, never deleted. */
export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // The customer's code in our accounting system, when it has one.
    code: text("code"),
    // How the name appears in transfer descriptions ("ORNEK"), for suggesting the customer from a receipt.
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check("customers_name", sql`length(trim(${t.name})) > 0`),
    uniqueIndex("customers_name_unique").on(sql`lower(${t.name})`),
    uniqueIndex("customers_code_unique").on(t.code).where(sql`${t.code} IS NOT NULL`),
  ],
);
