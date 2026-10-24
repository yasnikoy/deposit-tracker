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
import { BL_STATUSES, DOCUMENT_KINDS, LEDGER_TYPES, PAYMENT_KINDS, REQUEST_TYPES, SEND_STATUSES } from "../../domain/records";
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
    uploadedBy: integer("uploaded_by")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at").notNull(),
  },
  (t) => [
    check("documents_kind", sql`${t.kind} IN (${sqlList(DOCUMENT_KINDS)})`),
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
    evidenceDocumentId: integer("evidence_document_id")
      .notNull()
      .references(() => documents.id),
    extractedFields: text("extracted_fields", { mode: "json" }).$type<Record<string, unknown>>(),
    extractedBlNumbers: text("extracted_bl_numbers", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    blNoHint: text("bl_no_hint"),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ...voidColumns(),
  },
  (t) => [
    check("deposit_payments_amount", sql`${t.amountMinor} > 0`),
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
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ...voidColumns(),
  },
  (t) => [
    check("bills_of_lading_amount", sql`${t.depositAmountMinor} > 0`),
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
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    check("ledger_entries_type", sql`${t.type} IN (${sqlList(LEDGER_TYPES)})`),
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
    portalRef: text("portal_ref"),
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
    // Portal requests are recorded after filing, so they are never queued or failed.
    check("requests_portal_sent", sql`${t.channel} <> 'PORTAL' OR ${t.sendStatus} = 'SENT'`),
    // One live request per attempt; a failed send may be retried under the same attempt number.
    uniqueIndex("requests_attempt_unique")
      .on(t.blId, t.type, t.attemptNo)
      .where(sql`${t.sendStatus} <> 'FAILED'`),
    index("requests_bl").on(t.blId),
  ],
);
