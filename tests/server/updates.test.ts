import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVersion } from "@/domain/versions";
import { APP_VERSION } from "@/lib/version";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { packageName } from "@/server/release";
import { checkForUpdate, stageUpdate, updateState, verifyPackage } from "@/server/updates";
import { createTestDb, makeUser } from "../support/db";

const [major, minor] = parseVersion(APP_VERSION)!;
const NEXT_MINOR = `${major}.${minor + 1}.0`;
const NEXT_MAJOR = `${major + 1}.0.0`;

type Reply = { status: number; json?: unknown; bytes?: Buffer };
/** A fetch that answers by URL; anything else is a failed request. */
function fakeFetch(routes: Record<string, Reply>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const r = routes[String(input)];
    if (!r) return new Response(null, { status: 599 });
    return new Response(r.bytes ? new Uint8Array(r.bytes) : JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
}

const LATEST = "https://api.github.com/repos/yasnikoy/deposit-tracker/releases/latest";
const release = (version: string) => ({
  tag_name: `v${version}`,
  body: "Notlar",
  html_url: `https://github.com/yasnikoy/deposit-tracker/releases/tag/v${version}`,
  published_at: "2026-11-02T08:00:00Z",
  assets: [
    { name: packageName(version), browser_download_url: `https://dl.example/${version}.zip` },
    { name: `${packageName(version)}.sig`, browser_download_url: `https://dl.example/${version}.zip.sig` },
  ],
});

let db: Db;
let admin: AuthUser;
let root: string;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-root-"));
  Object.assign(updateState(), { checkedAt: null, error: null, available: null, staged: null });
});

afterEach(() => {
  delete process.env.APP_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("update check", () => {
  it("offers a newer release of the same major version, with its package and signature", async () => {
    const state = await checkForUpdate(fakeFetch({ [LATEST]: { status: 200, json: release(NEXT_MINOR) } }));
    expect(state.error).toBeNull();
    expect(state.available).toMatchObject({ version: NEXT_MINOR, kind: "install", notes: "Notlar", zipUrl: `https://dl.example/${NEXT_MINOR}.zip` });
  });

  it("points a new major version to the manual steps, and ignores the current version", async () => {
    expect((await checkForUpdate(fakeFetch({ [LATEST]: { status: 200, json: release(NEXT_MAJOR) } }))).available?.kind).toBe("manual");
    expect((await checkForUpdate(fakeFetch({ [LATEST]: { status: 200, json: release(APP_VERSION) } }))).available).toBeNull();
  });

  it("keeps a failed check as an error, and no releases at all as up to date", async () => {
    expect(await checkForUpdate(fakeFetch({ [LATEST]: { status: 500 } }))).toMatchObject({ error: "GitHub: HTTP 500" });
    expect(await checkForUpdate(fakeFetch({ [LATEST]: { status: 404 } }))).toMatchObject({ error: null, available: null });
  });
});

describe("installing an update", () => {
  it("accepts only packages signed with the release key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const zip = Buffer.from("package");
    const signature = crypto.sign(null, zip, privateKey);
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyPackage(zip, signature, pem)).toBe(true);
    expect(verifyPackage(Buffer.from("changed package"), signature, pem)).toBe(false);
    // Signed by anyone else: not the built-in release key.
    expect(verifyPackage(zip, signature)).toBe(false);
  });

  it("is refused outside the installed app, for non-admins, and for a package not signed with the release key", async () => {
    const zip = Buffer.from("not really a release");
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const net = fakeFetch({
      [LATEST]: { status: 200, json: release(NEXT_MINOR) },
      [`https://dl.example/${NEXT_MINOR}.zip`]: { status: 200, bytes: zip },
      [`https://dl.example/${NEXT_MINOR}.zip.sig`]: { status: 200, bytes: crypto.sign(null, zip, privateKey) },
    });
    await checkForUpdate(net);
    await expect(stageUpdate(db, admin, net)).rejects.toMatchObject({ messageKey: "updates.errors.notInstalled" });

    process.env.APP_ROOT = root;
    const ops = await makeUser(db, "ops", ["OPERATIONS"]);
    await expect(stageUpdate(db, ops, net)).rejects.toThrow(ForbiddenError);
    await expect(stageUpdate(db, admin, net)).rejects.toMatchObject({ messageKey: "updates.errors.signature" });
    expect(fs.existsSync(path.join(root, "update", "pending.json"))).toBe(false);
  });
});
