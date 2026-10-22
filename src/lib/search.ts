/**
 * Case- and diacritic-insensitive form for Turkish search:
 * "ŞULE", "Şule" and "sule" all match; "İ", "I", "ı" and "i" fold to "i".
 */
export function normalizeForSearch(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function matchesSearch(haystack: string, query: string): boolean {
  const needle = normalizeForSearch(query.trim());
  if (needle === "") return true;
  return normalizeForSearch(haystack).includes(needle);
}
