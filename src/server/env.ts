import "server-only";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Runtime data (database, files, logs, backups). Never touched by updates.
  DATA_DIR: z.string().min(1).default("./data"),
  // Rule 13: dry-run unless explicitly set to live in production.
  EMAIL_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  // Encryption key for mail passwords; defaults to deposit.key next to the data folder.
  KEY_FILE: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema> & { dataDir: string };

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.parse(process.env);
  if (parsed.EMAIL_MODE === "live" && parsed.NODE_ENV !== "production") {
    throw new Error("EMAIL_MODE=live is only allowed in production");
  }
  cached = { ...parsed, dataDir: path.resolve(parsed.DATA_DIR) };
  return cached;
}
