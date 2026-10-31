/** In-app notifications (ARCHITECTURE → Settings → Notifications); each kind can be switched off. */

export const NOTIFICATION_KINDS = ["MENTION", "CORRECTION", "UNPROCESSED_REPLY", "WRITE_OFF_PROPOSED", "WRITE_OFF_DECIDED"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The on/off setting of each kind; a write-off proposal and its decision share one. */
export const NOTIFICATION_SETTINGS = {
  MENTION: "notifications.inAppMention",
  CORRECTION: "notifications.inAppCorrection",
  UNPROCESSED_REPLY: "notifications.inAppUnprocessedReply",
  WRITE_OFF_PROPOSED: "notifications.inAppWriteOff",
  WRITE_OFF_DECIDED: "notifications.inAppWriteOff",
} as const satisfies Record<NotificationKind, string>;
