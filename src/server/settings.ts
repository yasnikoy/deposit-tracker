import "server-only";
import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import {
  isOverridableSettingKey,
  isSecretSetting,
  isSettingKey,
  parseSettingValue,
  SETTING_KEYS,
  type SettingKey,
  type SettingValue,
} from "@/domain/settings/definitions";
import { resolveSetting } from "@/domain/settings/resolve";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { getDb, type Db, type DbOrTx } from "./db/client";
import { agencies, billsOfLading, settings, settingsHistory, users } from "./db/schema";
import { DomainError } from "./errors";
import { agencyOverrideColumns, blOverrideColumns } from "./agency-overrides";
import { decryptSecret, encryptSecret } from "./secrets";

export const SEED_FILE = path.join(process.cwd(), "seed", "settings.json");

export type SettingScope = { agencyId?: number; blId?: number };

function readGlobal<K extends SettingKey>(db: DbOrTx, key: K): SettingValue<K> {
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  if (!row) throw new Error(`Setting "${key}" is missing; was the seed loaded?`);
  return parseSettingValue(key, row.value);
}

/**
 * The only way code reads business values. Resolution: B/L override → agency override → global;
 * null inherits. With a B/L scope the agency is the B/L's own agency.
 */
export function getSetting<K extends SettingKey>(
  key: K,
  scope: SettingScope = {},
  db: DbOrTx = getDb(),
): SettingValue<K> {
  const global = readGlobal(db, key);
  if ((scope.agencyId === undefined && scope.blId === undefined) || !isOverridableSettingKey(key)) return global;

  let agencyId = scope.agencyId;
  let blValue: SettingValue<K> | null = null;
  if (scope.blId !== undefined) {
    const bl = db
      .select({ agencyId: billsOfLading.agencyId, value: blOverrideColumns[key] })
      .from(billsOfLading)
      .where(eq(billsOfLading.id, scope.blId))
      .get();
    if (!bl) throw new Error(`B/L ${scope.blId} not found`);
    if (agencyId !== undefined && agencyId !== bl.agencyId) throw new Error(`B/L ${scope.blId} is not under agency ${agencyId}`);
    agencyId = bl.agencyId;
    blValue = bl.value as SettingValue<K> | null;
  }
  const row = db.select({ value: agencyOverrideColumns[key] }).from(agencies).where(eq(agencies.id, agencyId!)).get();
  if (!row) throw new Error(`Agency ${agencyId} not found`);
  return resolveSetting<SettingValue<K>>({ global, agency: row.value as SettingValue<K> | null, bl: blValue });
}

export type SettingListItem = {
  key: SettingKey;
  /** For secret settings always "": the stored value never leaves the server. */
  value: unknown;
  /** Secret settings: whether a value is stored. */
  secretSet?: boolean;
  changedAt: string | null;
  changedBy: string | null;
};

/** All global values with their last change, for the settings screen. */
export function listSettings(db: Db, actor: AuthUser): SettingListItem[] {
  authorize(actor, "settings.view");
  const values = new Map(db.select().from(settings).all().map((row) => [row.key, row.value]));
  const history = db
    .select({ key: settingsHistory.key, changedAt: settingsHistory.changedAt, changedBy: users.displayName })
    .from(settingsHistory)
    .leftJoin(users, eq(users.id, settingsHistory.changedBy))
    .orderBy(desc(settingsHistory.id))
    .all();
  return SETTING_KEYS.map((key) => {
    const last = history.find((h) => h.key === key);
    const item = { key, value: values.get(key), changedAt: last?.changedAt ?? null, changedBy: last?.changedBy ?? null };
    return isSecretSetting(key) ? { ...item, value: "", secretSet: values.get(key) !== "" } : item;
  });
}

/** What history and audit record for a secret: that it changed, never the value (rule 14). */
const SECRET_MARK = { secret: "changed" };

/** A secret setting decrypted for use (e.g. the SMTP password); "" when not set. */
export function getSecretSetting(key: SettingKey, db: DbOrTx = getDb()): string {
  if (!isSecretSetting(key)) throw new Error(`${key} is not a secret setting`);
  const stored = getSetting(key, {}, db) as string;
  return stored === "" ? "" : decryptSecret(stored);
}

/**
 * Saves changed global settings together; each change gets a history row and an audit row.
 * Unchanged values are skipped. Returns the keys that changed. A secret arrives as plain
 * text, is stored encrypted, and is recorded only as "changed"; an empty secret is skipped.
 */
export function updateSettings(
  db: Db,
  actor: AuthUser,
  input: { changes: { key: string; value: unknown }[]; reason?: string | null },
  now: Date = new Date(),
): SettingKey[] {
  const roleUsed = authorize(actor, "settings.update");
  const parsed = input.changes.map(({ key, value }) => {
    if (!isSettingKey(key)) throw new DomainError("errors.validation");
    try {
      return { key, value: parseSettingValue(key, value) as unknown };
    } catch {
      throw new DomainError("settings.invalid");
    }
  });
  const at = now.toISOString();
  const reason = input.reason?.trim() || null;

  return db.transaction((tx) => {
    const current = new Map(
      tx
        .select()
        .from(settings)
        .where(inArray(settings.key, parsed.map((p) => p.key)))
        .all()
        .map((row) => [row.key, row.value]),
    );
    const changed: SettingKey[] = [];
    for (const { key, value } of parsed) {
      const secret = isSecretSetting(key);
      if (secret && value === "") continue;
      const before = current.get(key) ?? null;
      if (!secret && JSON.stringify(before) === JSON.stringify(value)) continue;
      const stored = secret ? encryptSecret(value as string) : value;
      const [logBefore, logAfter] = secret ? [before === "" ? null : SECRET_MARK, SECRET_MARK] : [before, value];
      tx.update(settings).set({ value: stored, updatedAt: at, updatedBy: actor.id }).where(eq(settings.key, key)).run();
      tx.insert(settingsHistory)
        .values({ key, oldValue: logBefore, newValue: logAfter, changedBy: actor.id, changedAt: at, reason })
        .run();
      writeAudit(
        tx,
        { actorUserId: actor.id, roleUsed, action: "settings.update", entityType: "setting", entityId: key, before: logBefore, after: logAfter, reason },
        now,
      );
      changed.push(key);
    }
    return changed;
  });
}

/** Inserts seed values for keys not yet in the database. Existing values are never touched. */
export function seedSettings(db: Db, seedFile: string = SEED_FILE, now: Date = new Date()): string[] {
  const seed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ seedFile, "utf8")) as { settings: Record<string, unknown> };
  const inserted: string[] = [];

  db.transaction((tx) => {
    for (const [key, raw] of Object.entries(seed.settings)) {
      if (!isSettingKey(key)) throw new Error(`Unknown setting "${key}" in seed file`);
      const value = parseSettingValue(key, raw);
      const exists = tx.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
      if (exists) continue;

      const at = now.toISOString();
      tx.insert(settings).values({ key, value, updatedAt: at, updatedBy: null }).run();
      tx.insert(settingsHistory).values({ key, oldValue: null, newValue: value, changedBy: null, changedAt: at }).run();
      writeAudit(
        tx,
        { actorUserId: null, roleUsed: null, action: "settings.seed", entityType: "setting", entityId: key, after: value },
        now,
      );
      inserted.push(key);
    }
  });
  return inserted;
}
