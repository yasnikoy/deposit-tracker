import "server-only";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  isSettingKey,
  parseSettingValue,
  type SettingKey,
  type SettingValue,
} from "@/domain/settings/definitions";
import { writeAudit } from "./audit";
import { getDb, type Db, type DbOrTx } from "./db/client";
import { settings, settingsHistory } from "./db/schema";

export const SEED_FILE = path.join(process.cwd(), "seed", "settings.json");

export type SettingScope = { agencyId?: number; blId?: number };

/**
 * Resolution order: B/L override → agency override → global; null inherits.
 * Agencies and B/Ls arrive in later build steps, so only the global level exists yet.
 */
export function getSetting<K extends SettingKey>(
  key: K,
  _scope: SettingScope = {},
  db: DbOrTx = getDb(),
): SettingValue<K> {
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  if (!row) throw new Error(`Setting "${key}" is missing; was the seed loaded?`);
  return parseSettingValue(key, row.value);
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
