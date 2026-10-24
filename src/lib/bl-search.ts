import { parseAmountInput } from "./money";
import { matchesSearch } from "./search";

/** Global search input: free text, or a pasted list of B/L / container numbers. */
export type BlSearch = { kind: "empty" } | { kind: "text"; text: string } | { kind: "list"; numbers: string[] };

export type SearchableBl = { blNo: string; containers: string[]; agencyName: string; depositAmountMinor: number };
export type BlMatchField = "blNo" | "container" | "agency" | "amount";

const compact = (value: string) => value.replace(/\s/g, "").toUpperCase();
const looksLikeNumber = (token: string) => /\d/.test(token) && /^[A-Za-z0-9/-]{3,40}$/.test(token);

/**
 * Several tokens that all look like B/L or container numbers (letters/digits with a digit)
 * form a list; anything else is free text, so "Maersk Line" or "3.000,50" stay one term.
 */
export function parseBlSearch(input: string): BlSearch {
  const text = input.trim();
  if (text === "") return { kind: "empty" };
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(looksLikeNumber)) {
    return { kind: "list", numbers: [...new Set(tokens.map((token) => token.toUpperCase()))] };
  }
  return { kind: "text", text };
}

/** The fields of a B/L that match the search; empty when it does not match. */
export function matchBl(bl: SearchableBl, search: BlSearch): BlMatchField[] {
  if (search.kind === "empty") return [];
  if (search.kind === "list") {
    const fields: BlMatchField[] = [];
    if (search.numbers.includes(bl.blNo.toUpperCase())) fields.push("blNo");
    if (bl.containers.some((c) => search.numbers.includes(c.toUpperCase()))) fields.push("container");
    return fields;
  }

  const fields: BlMatchField[] = [];
  const needle = compact(search.text);
  if (needle !== "" && bl.blNo.toUpperCase().includes(needle)) fields.push("blNo");
  if (needle !== "" && bl.containers.some((c) => c.toUpperCase().includes(needle))) fields.push("container");
  if (matchesSearch(bl.agencyName, search.text)) fields.push("agency");
  if (parseAmountInput(search.text) === bl.depositAmountMinor) fields.push("amount");
  return fields;
}
