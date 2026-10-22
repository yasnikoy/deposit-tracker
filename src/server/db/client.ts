import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { getEnv } from "../env";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export const DATABASE_FILE_NAME = "deposit.sqlite";

export function openDatabase(file: string): Db {
  const sqlite = new Database(/*turbopackIgnore: true*/ file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle({ client: sqlite, schema });
}

const globalForDb = globalThis as unknown as { db?: Db };

export function getDb(): Db {
  if (!globalForDb.db) {
    const { dataDir } = getEnv();
    fs.mkdirSync(dataDir, { recursive: true });
    globalForDb.db = openDatabase(path.join(/*turbopackIgnore: true*/ dataDir, DATABASE_FILE_NAME));
  }
  return globalForDb.db;
}
