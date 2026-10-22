export function normalizeIban(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** ISO 13616 mod-97 checksum. */
export function isValidIban(text: string): boolean {
  const iban = normalizeIban(text);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
