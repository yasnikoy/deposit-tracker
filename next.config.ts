import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

// Dev only: the app is opened from the office LAN by IP, and Next.js blocks its
// dev scripts for unknown hosts, which leaves pages without client JavaScript.
const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a!.address);

// Cache Components is intentionally off: every screen is session-bound and
// shows live ledger data, so plain dynamic rendering is used throughout.
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: lanAddresses,
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
