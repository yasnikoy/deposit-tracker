import type { NextConfig } from "next";

// Cache Components is intentionally off: every screen is session-bound and
// shows live ledger data, so plain dynamic rendering is used throughout.
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // pdfjs loads its worker file at run time; bundling it breaks that.
  serverExternalPackages: ["pdfjs-dist"],
  // Read at runtime from the working directory (migrations on start, seed values).
  outputFileTracingIncludes: {
    // pdfjs imports its worker at run time, so tracing does not see it (receipt reading).
    "/*": ["./drizzle/**/*", "./seed/**/*", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
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
