import { addBusinessDays, type BusinessCalendar, type IsoDate } from "./business-days";
import type { BlStatus } from "./records";

/** The date the first refund request becomes due: payment date + the first-request duration. */
export function firstRequestDueDate(paidAt: IsoDate, firstRequestDueDays: number, calendar: BusinessCalendar): IsoDate {
  return addBusinessDays(paidAt, firstRequestDueDays, calendar);
}

/**
 * The status shown to users. DUE is never stored: a PAID B/L reads as DUE once
 * its first-request due date has been reached under the current settings.
 */
export function displayStatus(
  bl: { status: Exclude<BlStatus, "DUE">; paidAt: IsoDate; firstRequestDueDays: number },
  today: IsoDate,
  calendar: BusinessCalendar,
): BlStatus {
  if (bl.status !== "PAID") return bl.status;
  return today >= firstRequestDueDate(bl.paidAt, bl.firstRequestDueDays, calendar) ? "DUE" : "PAID";
}
