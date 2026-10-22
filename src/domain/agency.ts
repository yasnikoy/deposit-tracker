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

/**
 * Agencies whose bank sender aliases occur in a receipt's sender/beneficiary name.
 * Only a suggestion: the accountant confirms the agency.
 */
export function matchAgencyBySenderName(
  senderName: string,
  agencies: readonly { id: number; bankSenderAliases: readonly string[] }[],
): number[] {
  const name = ` ${foldName(senderName)} `;
  if (name.trim() === "") return [];
  return agencies
    .filter((agency) =>
      agency.bankSenderAliases.some((alias) => {
        const folded = foldName(alias);
        return folded !== "" && name.includes(` ${folded} `);
      }),
    )
    .map((agency) => agency.id);
}
