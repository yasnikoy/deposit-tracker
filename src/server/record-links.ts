import "server-only";
import { t } from "@/i18n";
import { DomainError } from "./errors";

/** Records that name an agency or customer, by kind; a kind with zero is not listed. */
export type RecordLinks = Partial<Record<"bls" | "payments" | "refunds" | "emails" | "reportEmails" | "formTemplate", number>>;

/**
 * Refuses deleting a record that other records name: nothing is deleted from history
 * (rule 8), so such a record is deactivated instead. The message lists what names it.
 */
export function assertUnlinked(links: RecordLinks, messageKey: "agencies.errors.inUse" | "customers.errors.inUse"): void {
  const parts = Object.entries(links)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([kind, count]) => t(`recordLinks.${kind as keyof RecordLinks}`, { count: count! }));
  if (parts.length > 0) throw new DomainError(messageKey, { links: parts.join(", ") });
}
