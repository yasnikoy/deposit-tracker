// UI-side money input and display. Stored amounts are integer minor units plus a
// currency code; locale formatting happens only here and in exports.

const DIGITS = 2;

/**
 * Parses a user-typed amount into minor units (cents) without floating point.
 * Turkish format ("3.000,50") is primary; a lone dot with one or two decimals ("3000.50")
 * is read as a decimal point. Returns null for anything ambiguous, zero or negative.
 */
export function parseAmountInput(text: string): number | null {
  const value = text.replace(/\s/g, "");
  if (value === "") return null;

  let whole: string;
  let fraction = "";
  if (value.includes(",")) {
    const match = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/.exec(value);
    if (!match) return null;
    whole = match[1].replace(/\./g, "");
    fraction = match[2];
  } else if (/^\d+\.\d{1,2}$/.test(value)) {
    [whole, fraction] = value.split(".");
  } else if (/^(\d{1,3}(?:\.\d{3})+|\d+)$/.test(value)) {
    whole = value.replace(/\./g, "");
  } else {
    return null;
  }

  const minor = Number(whole) * 10 ** DIGITS + Number(fraction.padEnd(DIGITS, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

/** 300050 → "3.000,50" */
export function formatAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** DIGITS).toString();
  const fraction = (abs % 10 ** DIGITS).toString().padStart(DIGITS, "0");
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${fraction}`;
}

/** 630000, "USD" → "6.300,00 USD" */
export function formatMoney(minor: number, currency: string): string {
  return `${formatAmount(minor)} ${currency}`;
}
