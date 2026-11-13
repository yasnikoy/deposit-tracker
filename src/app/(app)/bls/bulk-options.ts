import "server-only";
import { istanbulToday } from "@/domain/business-days";
import { activeUnitOptions } from "@/server/agencies";
import { can } from "@/server/auth/can";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { listHoldReasons, listReplyTypes } from "@/server/lists";
import type { BulkOptions } from "./bl-bulk-actions";

/** The lists and permissions the bulk actions on Talepler and B/L'ler need; null when the user has none. */
export function bulkActionOptions(db: Db, user: AuthUser): BulkOptions | null {
  const allowed = {
    recordReply: can(user, "reply.record").allowed,
    recordRequest: can(user, "request.recordOutside").allowed,
    hold: can(user, "bl.hold").allowed,
    setUnit: can(user, "bl.update").allowed,
    archive: can(user, "email.link").allowed,
  };
  if (!Object.values(allowed).some(Boolean)) return null;
  return {
    replyTypes: allowed.recordReply ? listReplyTypes(db, user).filter((r) => r.active).map(({ id, name }) => ({ id, name })) : [],
    holdReasons: allowed.hold ? listHoldReasons(db, user).filter((r) => r.active).map(({ id, name }) => ({ id, name })) : [],
    units: allowed.setUnit ? activeUnitOptions(db) : {},
    today: istanbulToday(),
    can: allowed,
  };
}
