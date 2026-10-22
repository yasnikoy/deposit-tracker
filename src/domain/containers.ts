/**
 * Container numbers (ISO 6346): 3-letter owner code, category U/J/Z, 6-digit serial, check digit.
 * A wrong check digit is reported as a warning only: real numbers occasionally break the rule.
 */

export type ContainerCheck = { value: string; formatOk: boolean; checkDigitOk: boolean };

const FORMAT = /^[A-Z]{3}[UJZ]\d{7}$/;

export function normalizeContainerNumber(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Letter values skip multiples of 11: A=10, B=12, … K=21, L=23, … U=32, V=34, …
function letterValue(char: string): number {
  let value = 10;
  for (let code = 65; code < char.charCodeAt(0); code++) {
    value++;
    if (value % 11 === 0) value++;
  }
  return value;
}

function checkDigit(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = first10[i];
    const value = /\d/.test(char) ? Number(char) : letterValue(char);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function checkContainerNumber(text: string): ContainerCheck {
  const value = normalizeContainerNumber(text);
  const formatOk = FORMAT.test(value);
  return { value, formatOk, checkDigitOk: formatOk && checkDigit(value.slice(0, 10)) === Number(value[10]) };
}

/** Splits a typed or pasted list (commas, semicolons, spaces between numbers, new lines). */
export function parseContainerList(text: string): string[] {
  // Allow spaces and dashes inside a number ("CSQU 305438-3") but split between numbers.
  const tokens = text.match(/[A-Za-z]{4}[\s-]?\d{6}[\s-]?\d|[^\s,;]+/g) ?? [];
  return [...new Set(tokens.map(normalizeContainerNumber).filter((v) => v !== ""))];
}
