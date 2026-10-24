/** Placeholders an agency form template (`.docx`) may use, written as `{name}`. */
export const FORM_PLACEHOLDERS = [
  "agency_name",
  "bl_no",
  "containers",
  "container_count",
  "amount",
  "currency",
  "paid_at",
  "bank_name",
  "iban",
  "today",
] as const;
export type FormPlaceholder = (typeof FORM_PLACEHOLDERS)[number];

/** Template tags that are not documented placeholders, once each in order of appearance. */
export function unknownPlaceholders(tags: readonly string[]): string[] {
  const known: readonly string[] = FORM_PLACEHOLDERS;
  return [...new Set(tags.filter((tag) => !known.includes(tag)))];
}

export type FormBankAccountWarning = "none" | "several";

/**
 * `{bank_name}` / `{iban}` come from the single active account in the B/L currency.
 * With none or several, the form is still generated with both fields blank and a warning.
 */
export function pickFormBankAccount<A extends { currency: string; active: boolean }>(
  accounts: readonly A[],
  currency: string,
): { account: A | null; warning: FormBankAccountWarning | null } {
  const matching = accounts.filter((a) => a.active && a.currency === currency);
  if (matching.length === 1) return { account: matching[0], warning: null };
  return { account: null, warning: matching.length === 0 ? "none" : "several" };
}
