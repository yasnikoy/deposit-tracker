/**
 * Our internal file number: the two-digit year, a hyphen and five digits (26-12345). Transfer
 * descriptions write it with a "T" in front (T26-12345), which belongs to another system and is
 * dropped; "2612345" gets its hyphen.
 */
export const FILE_NUMBER_PATTERN = /^\d{2}-\d{5}$/;

export function normalizeFileNo(text: string): string {
  const value = text.trim().toUpperCase().replace(/\s+/g, "").replace(/^T(?=\d)/, "");
  return /^\d{7}$/.test(value) ? `${value.slice(0, 2)}-${value.slice(2)}` : value;
}

export const isValidFileNo = (value: string) => FILE_NUMBER_PATTERN.test(value);

/** The file number in a transfer description, if it names one ("… T26-12345 …"). */
export function findFileNo(description: string): string | null {
  const match = /(?<![\p{L}\p{N}])T?(\d{2}-\d{5})(?![\p{N}])/iu.exec(description);
  return match ? match[1] : null;
}
