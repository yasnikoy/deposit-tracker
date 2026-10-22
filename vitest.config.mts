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
    env: { NODE_ENV: "test", TZ: "UTC" },
  },
});
