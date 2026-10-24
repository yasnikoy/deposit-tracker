import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      // Next.js resolves "server-only" to an empty module on the server; tests run server code directly.
      "server-only": path.join(root, "tests/support/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Uploaded files in tests go to a throwaway folder, never ./data.
    env: {
      NODE_ENV: "test",
      TZ: "UTC",
      DATA_DIR: path.join(os.tmpdir(), "deposit-vitest-data"),
      KEY_FILE: path.join(os.tmpdir(), "deposit-vitest.key"),
    },
  },
});
