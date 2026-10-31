/** Semantic versions as the releases use them ("v1.2.3" tags, "1.2.3" in package.json). */
export type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, 0 when equal, positive when newer. Invalid versions sort oldest. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a) ?? [-1, -1, -1];
  const vb = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  return 0;
}

/**
 * What a newer release means for the installed app (ARCHITECTURE → Updates): the same major
 * version is installed from the app; a new major version needs manual steps (runbook); an
 * older, equal or unreadable version is never offered. So 1.0.0, the go-live release, is
 * installed by hand over a 0.x test install.
 */
export function updateKind(current: string, latest: string): "none" | "install" | "manual" {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l || compareVersions(latest, current) <= 0) return "none";
  return l[0] === c[0] ? "install" : "manual";
}
