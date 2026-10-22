import { isValidBlNumber, matchesBlNumberPattern, normalizeBlNumber } from "@/domain/bl-number";
import { checkContainerNumber, parseContainerList } from "@/domain/containers";
import { t } from "@/i18n";

/** Non-blocking hints shown while typing; the server only enforces hard rules. */
export function blRowWarnings(blNoText: string, containersText: string, patterns: string[]): string[] {
  const warnings: string[] = [];
  const blNo = normalizeBlNumber(blNoText);
  if (blNo && isValidBlNumber(blNo) && patterns.length > 0 && !matchesBlNumberPattern(blNo, patterns)) {
    warnings.push(t("bls.patternWarning"));
  }
  const badDigits = parseContainerList(containersText).filter((c) => {
    const check = checkContainerNumber(c);
    return check.formatOk && !check.checkDigitOk;
  });
  if (badDigits.length > 0) warnings.push(t("bls.checkDigitWarning", { list: badDigits.join(", ") }));
  return warnings;
}

/** Candidates offered for a payment: extracted from the receipt, plus the accountant's hint. */
export function blCandidatesOf(payment: { extractedBlNumbers: string[]; blNoHint: string | null }): string[] {
  return [...new Set([...(payment.blNoHint ? [payment.blNoHint] : []), ...payment.extractedBlNumbers])];
}
