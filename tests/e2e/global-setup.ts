import { execFileSync } from "node:child_process";
import { E2E_DATA_DIR } from "../../playwright.config";

export const E2E_ADMIN = { username: "e2e-admin", displayName: "E2E Yönetici", password: "E2e-admin-pass-1" };

/** Creates the first admin through the same script the office PC uses. */
export default function globalSetup() {
  execFileSync("pnpm", ["-s", "create-admin", E2E_ADMIN.username, E2E_ADMIN.displayName], {
    input: `${E2E_ADMIN.password}\n${E2E_ADMIN.password}\n`,
    env: { ...process.env, DATA_DIR: E2E_DATA_DIR },
    stdio: ["pipe", "inherit", "inherit"],
  });
}
