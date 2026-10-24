/**
 * Outgoing email templates (Turkish, edited in settings). `{name}` placeholders are filled
 * in one pass; a `[[name]] … [[/name]]` block is kept only when `{name_section}` has content,
 * so a batched email leaves out an empty request-type section with its intro line.
 */

export const EMAIL_TEMPLATE_KEYS = ["REFUND_REQUEST", "FOLLOW_UP", "BATCH", "BATCH_LINE"] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Placeholders each template may use; shown next to the editor. */
export const EMAIL_TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKey, readonly string[]> = {
  REFUND_REQUEST: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "signature"],
  FOLLOW_UP: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "portal_ref", "signature"],
  BATCH: ["agency_name", "bl_no", "refund_section", "statement_section", "signature"],
  BATCH_LINE: ["bl_no", "containers", "amount", "currency", "attempt_no"],
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
