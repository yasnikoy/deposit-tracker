import type { NextConfig } from "next";

// Cache Components is intentionally off: every screen is session-bound and
// shows live ledger data, so plain dynamic rendering is used throughout.
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Read at runtime from the working directory (migrations on start, seed values).
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*", "./seed/**/*"],
  },
  // Rule 15: live data never ends up in a build.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./data-*/**/*", "./tests/**/*", "./docs/**/*", "./scripts/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
