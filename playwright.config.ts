import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const E2E_DATA_DIR = "data-e2e";
// Outside the data folder, like on the office PC; recreated with the data for every run.
const E2E_KEY_FILE = "e2e.key";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A fresh, separate data folder for every run; the real ./data is never touched.
    command: `node -e "for (const p of ['${E2E_DATA_DIR}','${E2E_KEY_FILE}']) require('fs').rmSync(p,{recursive:true,force:true})" && next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env: { DATA_DIR: E2E_DATA_DIR, KEY_FILE: E2E_KEY_FILE, EMAIL_MODE: "dry-run" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
