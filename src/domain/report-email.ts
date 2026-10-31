/**
 * The operations report email (ARCHITECTURE → Reports and exports → Report email): sections it
 * can carry and who may receive it. Internal figures never reach an agency.
 */

export const REPORT_SECTIONS = ["REQUESTED", "REMAINING", "COLLECTED", "PROBLEMS"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export type RecipientRules = {
  /** Domains from the reports setting; exact matches only. */
  internalDomains: readonly string[];
  /** The app's sender address; its domain counts as internal. Empty until the mailbox is set up. */
  senderAddress: string;
  /** Every address on any agency's recipient lists. */
  agencyAddresses: readonly string[];
};

/** Recipients a report may not go to: outside the internal domains, or on an agency's recipient list. */
export function refusedRecipients(addresses: readonly string[], rules: RecipientRules): { external: string[]; agency: string[] } {
  const internal = new Set(rules.internalDomains.map((d) => d.toLowerCase()));
  if (rules.senderAddress) internal.add(domainOf(rules.senderAddress));
  const agency = new Set(rules.agencyAddresses.map((a) => a.toLowerCase()));
  return {
    external: addresses.filter((address) => !internal.has(domainOf(address))),
    agency: addresses.filter((address) => agency.has(address.toLowerCase())),
  };
}
