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
  "REPORT",
  "REPORT_SUMMARY",
  "REPORT_LINE_REQUESTED",
  "REPORT_LINE_REMAINING",
  "REPORT_LINE_TOTAL",
  "REPORT_LINE_COLLECTED",
  "REPORT_LINE_TRANSFERRED",
  "WEEKLY_SUMMARY",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Placeholders each template may use; shown next to the editor. */
export const EMAIL_TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKey, readonly string[]> = {
  REFUND_REQUEST: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "signature"],
  FOLLOW_UP: ["agency_name", "bl_no", "containers", "amount", "currency", "attempt_no", "signature"],
  // First request and follow-ups alike; a follow-up replies in the statement thread.
  DEDUCTION_STATEMENT: ["agency_name", "bl_no", "containers", "deduction_amount", "currency", "attempt_no", "signature"],
  BATCH: ["agency_name", "bl_no", "refund_section", "statement_section", "signature"],
  // In the statement section, {amount} is the unexplained deduction.
  BATCH_LINE: ["bl_no", "containers", "amount", "currency", "attempt_no"],
  // Header above the quoted earlier email in a reply; the earlier text follows it.
  REPLY_QUOTE: ["from", "sent_at", "to", "cc_section", "subject"],
  // Internal reminder to our own team; never sent to agencies.
  DAILY_UNPROCESSED: ["count", "warning_days", "agency_lines", "link"],
  // Operations report to internal addresses: the body is the intro; section summaries and the signature follow it.
  REPORT: ["date"],
  // The section summaries below the report intro: a `[[section]] … [[/section]]` block per section,
  // kept only when it is chosen; each `{…_lines}` is built from that section's line template.
  REPORT_SUMMARY: [
    "requested_period",
    "requested_lines",
    "remaining_lines",
    "collected_period",
    "collected_lines",
    "transferred_period",
    "transferred_lines",
    "deduction_open",
    "disputed",
    "failed",
    "waiting",
    "waiting_days",
  ],
  // One line per agency and currency; {amount} without the currency, as in BATCH_LINE.
  REPORT_LINE_REQUESTED: ["agency", "currency", "count", "amount"],
  REPORT_LINE_REMAINING: ["agency", "currency", "count", "amount"],
  // One line per currency, after the remaining-deposit lines.
  REPORT_LINE_TOTAL: ["currency", "count", "amount"],
  REPORT_LINE_COLLECTED: ["agency", "currency", "count", "amount", "deductions", "write_off"],
  // One line per transfer.
  REPORT_LINE_TRANSFERRED: ["agency", "from_bl", "to_bl", "amount", "currency", "date"],
  // Optional weekly email to our own team; never sent to agencies.
  WEEKLY_SUMMARY: ["date", "balance_lines", "waiting_days", "waiting_count", "waiting_lines", "unprocessed_count", "overdue_count", "link"],
};

/**
 * Sample values for the live preview in settings only; real emails take them from the records.
 * Every placeholder above has one (tested), so the preview never shows a raw `{name}`.
 * `{signature}` comes from the signature setting, the batch sections are built from
 * BATCH_LINE and the report summary's `{…_lines}` from the REPORT_LINE_* templates, with these values.
 */
export const EMAIL_TEMPLATE_SAMPLES: Record<string, string> = {
  agency_name: "Örnek Denizcilik",
  bl_no: "MEDU1234567",
  containers: "MSCU1234565, CSQU3054383",
  amount: "3.000,00",
  currency: "USD",
  attempt_no: "2",
  deduction_amount: "700,00",
  from: "Örnek Lojistik Depozito <depozito@ornek-lojistik.com.tr>",
  sent_at: "16.10.2026 10:30",
  to: "iade@ornek-denizcilik.com",
  cc_section: "muhasebe@ornek-denizcilik.com",
  subject: "Depozito İade Talebi – B/L MEDU1000001",
  count: "3",
  warning_days: "1",
  agency_lines: "• Örnek Denizcilik: 2\n• Deniz Hatları: 1",
  link: "http://DEPOZITO-PC:3000/replies",
  date: "16.10.2026",
  balance_lines: "• 45.250,00 USD (12 B/L)\n• 3.800,00 EUR (2 B/L)",
  waiting_days: "30",
  waiting_count: "2",
  waiting_lines: "• MEDU1234567 · Örnek Denizcilik · 42 iş günü · 3.000,00 USD\n• MEDU7654321 · Deniz Hatları · 35 iş günü · 1.500,00 USD",
  unprocessed_count: "3",
  agency: "Örnek Denizcilik",
  deductions: "700,00",
  write_off: "0,00",
  from_bl: "MEDU1234567",
  to_bl: "MEDU7654321",
  requested_period: "16.10.2026",
  collected_period: "01.10.2026 – 16.10.2026",
  transferred_period: "16.10.2026",
  deduction_open: "1",
  disputed: "0",
  failed: "0",
  waiting: "2",
  overdue_count: "1",
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
