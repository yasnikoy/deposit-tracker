/** In-app notifications (ARCHITECTURE → Settings → Notifications); each kind can be switched off. */

export const NOTIFICATION_KINDS = ["MENTION", "CORRECTION", "UNPROCESSED_REPLY", "WRITE_OFF_PROPOSED", "WRITE_OFF_DECIDED", "NEW_AGENCY", "NEW_CUSTOMER", "NEW_FEEDBACK"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The on/off setting of each kind; a write-off proposal and its decision share one. MENTION
 * (from the team notes, replaced by the B/L description) and UNPROCESSED_REPLY (agency replies
 * are no longer read from the mailbox) are no longer sent; older ones stay.
 */
export const NOTIFICATION_SETTINGS = {
  CORRECTION: "notifications.inAppCorrection",
  WRITE_OFF_PROPOSED: "notifications.inAppWriteOff",
  WRITE_OFF_DECIDED: "notifications.inAppWriteOff",
  NEW_AGENCY: "notifications.inAppNewAgency",
  NEW_CUSTOMER: "notifications.inAppNewCustomer",
  NEW_FEEDBACK: "notifications.inAppNewFeedback",
} as const satisfies Record<Exclude<NotificationKind, "MENTION" | "UNPROCESSED_REPLY">, string>;
