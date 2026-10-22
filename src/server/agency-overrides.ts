import "server-only";
import type { OverridableSettingKey } from "@/domain/settings/definitions";
import { agencies } from "./db/schema";

/** Agency column holding each overridable setting (null inherits the global value). */
export const agencyOverrideColumns = {
  "durations.firstRequestDueDays": agencies.firstRequestDueDays,
  "durations.upcomingDays": agencies.upcomingDays,
  "durations.followUpDays": agencies.followUpDays,
  "durations.statementRequestDays": agencies.statementRequestDays,
  "durations.statementFollowUpDays": agencies.statementFollowUpDays,
} satisfies Record<OverridableSettingKey, unknown>;

/** The same mapping by property name on a selected agency row. */
export const agencyOverrideFields = {
  "durations.firstRequestDueDays": "firstRequestDueDays",
  "durations.upcomingDays": "upcomingDays",
  "durations.followUpDays": "followUpDays",
  "durations.statementRequestDays": "statementRequestDays",
  "durations.statementFollowUpDays": "statementFollowUpDays",
} as const satisfies Record<OverridableSettingKey, keyof typeof agencies.$inferSelect>;
