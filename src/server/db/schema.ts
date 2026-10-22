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
  },
  (t) => [index("settings_history_key").on(t.key)],
);
