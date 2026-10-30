import pkg from "../../package.json";

/**
 * The app version (SemVer; ARCHITECTURE.md → Technical decisions → Versioning). package.json
 * is the single source; raise it with `pnpm version minor|patch`, which also tags the commit.
 * Import only from server code, so the rest of package.json stays out of the browser bundle.
 */
export const APP_VERSION: string = pkg.version;
