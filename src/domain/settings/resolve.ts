/**
 * Setting resolution: B/L override → agency override → global.
 * Only null/undefined inherits; 0 or false is a real override.
 */
export function resolveSetting<T>(levels: { global: T; agency?: T | null; bl?: T | null }): T {
  if (levels.bl !== null && levels.bl !== undefined) return levels.bl;
  if (levels.agency !== null && levels.agency !== undefined) return levels.agency;
  return levels.global;
}
