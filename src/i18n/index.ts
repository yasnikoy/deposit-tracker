import tr from "./tr.json";

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = Leaves<typeof tr>;
export type TranslationParams = Record<string, string | number>;

const numberFormat = new Intl.NumberFormat("tr-TR");

function lookup(key: string): string | undefined {
  let node: unknown = tr;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function isTranslationKey(key: string): key is TranslationKey {
  return lookup(key) !== undefined;
}

/** All UI text comes from tr.json; `{name}` placeholders are filled from params. */
export function t(key: TranslationKey, params?: TranslationParams): string {
  const template = lookup(key);
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number" ? numberFormat.format(value) : value;
  });
}
