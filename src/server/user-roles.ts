import "server-only";
import { eq } from "drizzle-orm";
import { ROLES, type Role } from "@/domain/roles";
import type { DbOrTx } from "./db/client";
import { userRoles } from "./db/schema";

export const sortRoles = (roles: Role[]) => [...roles].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));

export function loadRoles(db: DbOrTx, userId: number): Role[] {
  const rows = db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return sortRoles(rows.map((r) => r.role));
}
