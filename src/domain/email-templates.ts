/**
 * Outgoing email templates (Turkish, edited in settings). `{name}` placeholders are filled
 * in one pass; a `[[name]] … [[/name]]` block is kept only when `{name_section}` has content,
 * so a batched email leaves out an empty request-type section with its intro line.
 */

export const EMAIL_TEMPLATE_KEYS = [
  "REFUND_REQUEST",
  "FOLLOW_UP",
  "DEDUCTION_STATEMENT",
  "BATCH",
  "BATCH_LINE",
  "REPLY_QUOTE",
  "DAILY_UNPROCESSED",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Placeholders each template may use; shown next to the editor. */
export const EMAIL_TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKey, readonly string[]> = {
  REFUND_REQUEST: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "signature"],
  FOLLOW_UP: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "portal_ref", "signature"],
  // First request and follow-ups alike; a follow-up replies in the statement thread.
  DEDUCTION_STATEMENT: ["agency_name", "bl_no", "containers", "deduction_amount", "currency", "attempt_no", "signature"],
  BATCH: ["agency_name", "bl_no", "refund_section", "statement_section", "signature"],
  // In the statement section, {amount} is the unexplained deduction.
  BATCH_LINE: ["bl_no", "containers", "amount", "currency", "attempt_no"],
  // Header above the quoted earlier email in a reply; the earlier text follows it.
  REPLY_QUOTE: ["from", "sent_at", "to", "cc_section", "subject"],
  // Internal reminder to our own team; never sent to agencies.
  DAILY_UNPROCESSED: ["count", "warning_days", "agency_lines", "link"],
};

/** Section blocks of the batched template; `[[refund]]` depends on `{refund_section}`. */
export const BATCH_SECTIONS = ["refund", "statement"] as const;

const BLOCK = /\[\[(\w+)\]\]\n?([\s\S]*?)\[\[\/\1\]\]\n?/g;
const PLACEHOLDER = /\{(\w+)\}/g;

export function renderTemplate(template: string, values: Record<string, string>): string {
  const withBlocks = template.replace(BLOCK, (_match, name: string, inner: string) =>
    (values[`${name}_section`] ?? "").trim() === "" ? "" : inner,
  );
  return withBlocks.replace(PLACEHOLDER, (match, name: string) => values[name] ?? match);
}

export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}
