import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, ensureKeyFile, resolveKeyFile } from "@/server/secrets";

let dir: string;
let keyFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-secrets-"));
  keyFile = path.join(dir, "deposit.key");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("secrets", () => {
  it("round-trips through AES-256-GCM; the stored text never contains the secret", () => {
    const stored = encryptSecret("yandex-app-password", keyFile);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("yandex");
    expect(decryptSecret(stored, keyFile)).toBe("yandex-app-password");
    // A fresh IV every time.
    expect(encryptSecret("yandex-app-password", keyFile)).not.toBe(stored);
  });

  it("creates the key file once, readable by its owner only", () => {
    ensureKeyFile(keyFile);
    const key = fs.readFileSync(keyFile);
    ensureKeyFile(keyFile);
    expect(fs.readFileSync(keyFile)).toEqual(key);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o077).toBe(0);
  });

  it("refuses tampered text and a different key", () => {
    const stored = encryptSecret("secret", keyFile);
    const tampered = stored.slice(0, -2) + (stored.endsWith("A") ? "B" : "A") + stored.slice(-1);
    expect(() => decryptSecret(tampered, keyFile)).toThrow();
    const other = path.join(dir, "other.key");
    expect(() => decryptSecret(stored, other)).toThrow(/key file/);
  });

  it("keeps the key file outside the data folder", () => {
    const data = path.join(dir, "data");
    expect(resolveKeyFile({ dataDir: data, KEY_FILE: undefined })).toBe(path.join(dir, "deposit.key"));
    expect(() => resolveKeyFile({ dataDir: data, KEY_FILE: path.join(data, "x.key") })).toThrow(/outside the data folder/);
    expect(resolveKeyFile({ dataDir: data, KEY_FILE: path.join(dir, "keys", "k.key") })).toBe(path.join(dir, "keys", "k.key"));
  });
});
