export const REQUEST_CHANNELS = ["EMAIL", "PORTAL"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

/** Folds case and Turkish letters and drops punctuation, for comparing bank sender names. */
function foldName(value: string): string {
  return value
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/İ/g, "I")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Items with an alias that occurs as whole words in a text (a receipt's name or description). */
export function matchByAliases(text: string, items: readonly { id: number; aliases: readonly string[] }[]): number[] {
  const haystack = ` ${foldName(text)} `;
  if (haystack.trim() === "") return [];
  return items
    .filter((item) =>
      item.aliases.some((alias) => {
        const folded = foldName(alias);
        return folded !== "" && haystack.includes(` ${folded} `);
      }),
    )
    .map((item) => item.id);
}

/**
 * Agencies whose bank sender aliases occur in a receipt's sender/beneficiary name.
 * Only a suggestion: the accountant confirms the agency.
 */
export function matchAgencyBySenderName(
  senderName: string,
  agencies: readonly { id: number; bankSenderAliases: readonly string[] }[],
): number[] {
  return matchByAliases(senderName, agencies.map((a) => ({ id: a.id, aliases: a.bankSenderAliases })));
}
