/** In-app notifications (ARCHITECTURE → Settings → Notifications); each kind can be switched off. */

export const NOTIFICATION_KINDS = ["MENTION", "CORRECTION", "UNPROCESSED_REPLY", "WRITE_OFF_PROPOSED", "WRITE_OFF_DECIDED", "NEW_AGENCY"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The on/off setting of each kind; a write-off proposal and its decision share one. MENTION
 * (from the team notes, replaced by the B/L description) is no longer sent; older ones stay.
 */
export const NOTIFICATION_SETTINGS = {
  CORRECTION: "notifications.inAppCorrection",
  UNPROCESSED_REPLY: "notifications.inAppUnprocessedReply",
  WRITE_OFF_PROPOSED: "notifications.inAppWriteOff",
  WRITE_OFF_DECIDED: "notifications.inAppWriteOff",
  NEW_AGENCY: "notifications.inAppNewAgency",
} as const satisfies Record<Exclude<NotificationKind, "MENTION">, string>;
