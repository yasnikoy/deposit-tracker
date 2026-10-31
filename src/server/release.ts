import "server-only";

/** The public GitHub repository whose releases carry the app's updates (ARCHITECTURE → Updates). */
export const RELEASE_REPOSITORY = "yasnikoy/deposit-tracker";

/** The package of a version, as `pnpm build:portable` names it; its signature is `<name>.sig`. */
export const packageName = (version: string) => `deposit-tracker-${version}-win-x64.zip`;

/**
 * Ed25519 public key of the release key (created Oct 31, 2026). The private half never leaves
 * the developer's machine; an update is installed only if its signature verifies with this key.
 */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAqYe8zY5egZCyjBO3jy/XQV1sA68Nzy8xbogoKQHkKLY=
-----END PUBLIC KEY-----`;
