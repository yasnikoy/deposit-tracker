/**
 * B/L number patterns: each agency configures regular expressions that recognise
 * its B/L numbers in receipt descriptions and email subjects/bodies.
 * Results are only suggestions; a user always confirms them.
 */

export const MAX_PATTERN_LENGTH = 200;
// Descriptions and email bodies are scanned up to this length.
const MAX_TEXT_LENGTH = 20_000;

export type PatternError = "empty" | "tooLong" | "invalid" | "matchesEmpty" | "unsafe";

// A quantified group that itself contains a quantifier, e.g. (a+)+ or (\d*)* — the classic
// catastrophic-backtracking shape. Conservative: may reject a few harmless patterns.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

function compile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function validateBlNumberPattern(pattern: string): PatternError | null {
  if (pattern.trim() === "") return "empty";
  if (pattern.length > MAX_PATTERN_LENGTH) return "tooLong";
  const regex = compile(pattern, "i");
  if (!regex) return "invalid";
  if (regex.test("")) return "matchesEmpty";
  if (NESTED_QUANTIFIER.test(pattern)) return "unsafe";
  return null;
}

/** All distinct candidates found by any pattern, upper-cased, in order of first appearance. */
export function extractBlNumbers(text: string, patterns: readonly string[]): string[] {
  const input = text.slice(0, MAX_TEXT_LENGTH);
  const found: { index: number; value: string }[] = [];
  for (const pattern of patterns) {
    if (validateBlNumberPattern(pattern) !== null) continue;
    for (const match of input.matchAll(new RegExp(pattern, "gi"))) {
      found.push({ index: match.index, value: match[0].trim().toUpperCase() });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((f) => f.value).filter((v) => v !== ""))];
}

/** Whether a whole B/L number matches at least one pattern. */
export function matchesBlNumberPattern(blNumber: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) => validateBlNumberPattern(pattern) === null && new RegExp(`^(?:${pattern})$`, "i").test(blNumber.trim()),
  );
}

/** B/L numbers are stored upper-case without spaces. */
export function normalizeBlNumber(text: string): string {
  return text.toUpperCase().replace(/\s+/g, "");
}

export function isValidBlNumber(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9\-/]{2,39}$/.test(value);
}

/**
 * A B/L number entered for a receipt that names other B/L numbers: worth a warning the user
 * confirms, never a block (receipts carry typos or several numbers).
 */
export function blNotOnReceipt(blNo: string, receiptCandidates: readonly string[]): boolean {
  const typed = normalizeBlNumber(blNo);
  return typed !== "" && receiptCandidates.length > 0 && !receiptCandidates.some((c) => normalizeBlNumber(c) === typed);
}
