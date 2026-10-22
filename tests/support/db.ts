import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Role } from "@/domain/roles";
import type { AuthUser } from "@/server/auth/types";
import { openDatabase, type Db } from "@/server/db/client";
import { seedLists } from "@/server/lists";
import { seedSettings } from "@/server/settings";
import { createUser } from "@/server/users";
import { loadRoles } from "@/server/user-roles";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const MIGRATIONS = path.join(ROOT, "drizzle");
export const SEED_FILE = path.join(ROOT, "seed", "settings.json");

export function createTestDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db, { migrationsFolder: MIGRATIONS });
  seedSettings(db, SEED_FILE);
  seedLists(db, SEED_FILE);
  return db;
}

export const TEST_PASSWORD = "correct-horse-1";

/** Creates a user directly (as the system) and returns it as an AuthUser. */
export async function makeUser(
  db: Db,
  username: string,
  roles: Role[],
  options: { mustChangePassword?: boolean } = {},
): Promise<AuthUser> {
  const id = await createUser(db, null, {
    username,
    displayName: username.toUpperCase(),
    roles,
    password: TEST_PASSWORD,
    mustChangePassword: options.mustChangePassword ?? false,
  });
  return {
    id,
    username,
    displayName: username.toUpperCase(),
    roles: loadRoles(db, id),
    active: true,
    mustChangePassword: options.mustChangePassword ?? false,
  };
}
