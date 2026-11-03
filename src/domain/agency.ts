export const REQUEST_CHANNELS = ["EMAIL", "PORTAL"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

/** A unit of an agency (e.g. its Mersin office) with its own request recipients. */
export type AgencyUnitRecipients = {
  id: number;
  name: string;
  active: boolean;
  toRecipients: readonly string[];
  ccRecipients: readonly string[];
};

/** Every B/L of an agency with an active unit names one of its active units. */
export function unitRequired(units: readonly { active: boolean }[]): boolean {
  return units.some((u) => u.active);
}

/**
 * An agency card is incomplete while requests cannot reach it: it has no To recipient, or,
 * with units, an active unit has none. Typical for an agency an accountant added by name with
 * its payment.
 */
export function agencyDetailsMissing(agency: { toRecipients: readonly string[]; units?: readonly { active: boolean; toRecipients: readonly string[] }[] }): boolean {
  const units = agency.units ?? [];
  return unitRequired(units) ? units.some((u) => u.active && u.toRecipients.length === 0) : agency.toRecipients.length === 0;
}

export type RequestRecipients =
  | { ok: true; unitId: number | null; to: readonly string[]; cc: readonly string[] }
  | { ok: false; problem: "UNIT_MISSING" | "NO_RECIPIENTS" };

/**
 * Where a B/L's requests go: its unit's recipients while the agency has active units (the B/L
 * must name one of them), otherwise the agency's own list.
 */
export function requestRecipients(
  agency: { toRecipients: readonly string[]; ccRecipients: readonly string[] },
  units: readonly AgencyUnitRecipients[],
  blUnitId: number | null,
): RequestRecipients {
  if (unitRequired(units)) {
    const unit = units.find((u) => u.active && u.id === blUnitId);
    if (!unit) return { ok: false, problem: "UNIT_MISSING" };
    return unit.toRecipients.length ? { ok: true, unitId: unit.id, to: unit.toRecipients, cc: unit.ccRecipients } : { ok: false, problem: "NO_RECIPIENTS" };
  }
  return agency.toRecipients.length
    ? { ok: true, unitId: null, to: agency.toRecipients, cc: agency.ccRecipients }
    : { ok: false, problem: "NO_RECIPIENTS" };
}

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
