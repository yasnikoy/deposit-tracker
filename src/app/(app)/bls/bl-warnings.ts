import { isValidBlNumber, matchesBlNumberPattern, normalizeBlNumber } from "@/domain/bl-number";
import { checkContainerNumber, parseContainerList } from "@/domain/containers";
import { t } from "@/i18n";

/** Non-blocking hint shown while typing a B/L number; the server only enforces hard rules. */
export function blNoWarnings(blNoText: string, patterns: string[]): string[] {
  const blNo = normalizeBlNumber(blNoText);
  return blNo && isValidBlNumber(blNo) && patterns.length > 0 && !matchesBlNumberPattern(blNo, patterns) ? [t("bls.patternWarning")] : [];
}

/** Non-blocking hint shown while typing containers: well-formed numbers whose check digit is off. */
export function containerWarnings(containersText: string): string[] {
  const badDigits = parseContainerList(containersText).filter((c) => {
    const check = checkContainerNumber(c);
    return check.formatOk && !check.checkDigitOk;
  });
  return badDigits.length > 0 ? [t("bls.checkDigitWarning", { list: badDigits.join(", ") })] : [];
}

/** Candidates offered for a payment: extracted from the receipt, plus the accountant's hint. */
export function blCandidatesOf(payment: { extractedBlNumbers: string[]; blNoHint: string | null }): string[] {
  return [...new Set([...(payment.blNoHint ? [payment.blNoHint] : []), ...payment.extractedBlNumbers])];
}
