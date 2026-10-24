import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./env";

// Rule 14: SMTP/IMAP passwords are encrypted at rest with a key that lives in a file
// outside the data folder, so it is never in the database, the logs or the backups.
const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The key file: KEY_FILE, or `deposit.key` next to the data folder. Never inside it. */
export function resolveKeyFile(env: { dataDir: string; KEY_FILE?: string }): string {
  const file = path.resolve(/*turbopackIgnore: true*/ env.KEY_FILE ?? path.join(/*turbopackIgnore: true*/ path.dirname(env.dataDir), "deposit.key"));
  const relative = path.relative(env.dataDir, file);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("The key file must be outside the data folder (it would end up in backups)");
  }
  return file;
}

const defaultKeyFile = () => resolveKeyFile(getEnv());

/** Creates the key file with a random key if it does not exist yet; owner-only permissions. */
export function ensureKeyFile(file: string = defaultKeyFile()): void {
  if (fs.existsSync(/*turbopackIgnore: true*/ file)) return;
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  fs.writeFileSync(/*turbopackIgnore: true*/ file, randomBytes(KEY_BYTES).toString("base64"), { flag: "wx", mode: 0o600 });
}

function readKey(file: string): Buffer {
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) throw new Error(`The key file is missing: ${file}`);
  const key = Buffer.from(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`The key file is invalid: ${file}`);
  return key;
}

/** `v1:<iv>:<tag>:<ciphertext>`, base64 parts. Creates the key file on first use. */
export function encryptSecret(plain: string, file: string = defaultKeyFile()): string {
  ensureKeyFile(file);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", readKey(file), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(stored: string, file: string = defaultKeyFile()): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", readKey(file), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
