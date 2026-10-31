import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { updateKind } from "@/domain/versions";
import { APP_VERSION } from "@/lib/version";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db } from "./db/client";
import { DomainError } from "./errors";
import { logger } from "./logger";
import { packageName, RELEASE_PUBLIC_KEY, RELEASE_REPOSITORY } from "./release";

export type AvailableRelease = {
  version: string;
  kind: "install" | "manual";
  notes: string;
  publishedAt: string | null;
  url: string;
  zipUrl: string | null;
  sigUrl: string | null;
};

export type UpdateState = {
  checkedAt: string | null;
  error: string | null;
  available: AvailableRelease | null;
  /** A verified package waiting for the restart that installs it. */
  staged: string | null;
};

type Fetch = typeof fetch;

// Kept in memory: the check runs at start and daily, so nothing needs to survive a restart.
const store = globalThis as unknown as { depositUpdateState?: UpdateState };
export const updateState = (): UpdateState => (store.depositUpdateState ??= { checkedAt: null, error: null, available: null, staged: null });

/** The installation folder (C:\DepositTracker), set by run.ps1; absent in development. */
export const installRoot = (): string | null => process.env.APP_ROOT || null;

/** Exit code that tells run.ps1 to install the staged update and start again right away. */
export const RESTART_FOR_UPDATE = 75;

/**
 * Asks GitHub for the latest release (outbound HTTPS only; ARCHITECTURE → Updates) and keeps
 * what it means for this version. A failed check is kept as an error for the health page.
 */
export async function checkForUpdate(fetchImpl: Fetch = fetch, now: Date = new Date()): Promise<UpdateState> {
  const state = updateState();
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `deposit-tracker/${APP_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      Object.assign(state, { checkedAt: now.toISOString(), error: null, available: null });
      return state;
    }
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    const release = (await res.json()) as { tag_name: string; body?: string; published_at?: string; html_url: string; assets?: { name: string; browser_download_url: string }[] };
    const kind = updateKind(APP_VERSION, release.tag_name);
    const version = release.tag_name.replace(/^v/, "");
    const asset = (name: string) => release.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
    state.available =
      kind === "none"
        ? null
        : {
            version,
            kind,
            notes: (release.body ?? "").slice(0, 20_000),
            publishedAt: release.published_at ?? null,
            url: release.html_url,
            zipUrl: asset(packageName(version)),
            sigUrl: asset(`${packageName(version)}.sig`),
          };
    Object.assign(state, { checkedAt: now.toISOString(), error: null });
    if (state.available) logger.info({ version, kind }, "update available");
  } catch (error) {
    Object.assign(state, { checkedAt: now.toISOString(), error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    logger.warn({ err: error }, "update check failed");
  }
  return state;
}

/** True only for a package signed with the release key. */
export function verifyPackage(zip: Buffer, signature: Buffer, publicKey: string = RELEASE_PUBLIC_KEY): boolean {
  try {
    return crypto.verify(null, zip, crypto.createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

async function download(fetchImpl: Fetch, url: string): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { "User-Agent": `deposit-tracker/${APP_VERSION}` }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new DomainError("updates.errors.download");
  return Buffer.from(await res.arrayBuffer());
}

/**
 * "Güncelle" (admin): downloads the newer release of the same major version, verifies its
 * signature with the built-in public key and stages it in `<root>\update`. run.ps1 installs it
 * at the next start, keeping the previous app folder, and switches back if the health check
 * fails. A new major version is never installed this way (runbook).
 */
export async function stageUpdate(db: Db, actor: AuthUser, fetchImpl: Fetch = fetch, now: Date = new Date()): Promise<string> {
  const roleUsed = authorize(actor, "update.install");
  const root = installRoot();
  if (!root) throw new DomainError("updates.errors.notInstalled");
  const release = updateState().available;
  if (!release || release.kind !== "install") throw new DomainError("updates.errors.nothingToInstall");
  if (!release.zipUrl || !release.sigUrl) throw new DomainError("updates.errors.noPackage");

  const [zip, signature] = await Promise.all([download(fetchImpl, release.zipUrl), download(fetchImpl, release.sigUrl)]);
  if (!verifyPackage(zip, signature)) {
    logger.error({ version: release.version }, "update package signature is invalid; not installed");
    throw new DomainError("updates.errors.signature");
  }
  const dir = path.join(/*turbopackIgnore: true*/ root, "update");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(/*turbopackIgnore: true*/ dir, packageName(release.version));
  fs.writeFileSync(`${file}.tmp`, zip);
  fs.renameSync(`${file}.tmp`, file);
  const pending = { version: release.version, file: path.basename(file), sha256: crypto.createHash("sha256").update(zip).digest("hex") };
  fs.writeFileSync(path.join(/*turbopackIgnore: true*/ dir, "pending.json"), JSON.stringify(pending, null, 2));
  updateState().staged = release.version;
  writeAudit(db, { actorUserId: actor.id, roleUsed, action: "update.stage", entityType: "system", after: { from: APP_VERSION, to: release.version, sha256: pending.sha256 } }, now);
  logger.info({ from: APP_VERSION, to: release.version }, "update staged; restarting to install it");
  return release.version;
}

/** Ends the process after the response is sent, so run.ps1 installs the staged update. */
export function restartForUpdate(delayMs = 1500): void {
  setTimeout(() => process.exit(RESTART_FOR_UPDATE), delayMs).unref();
}

/** At start, in the installed app only: a check after a minute, then daily. */
export function scheduleUpdateChecks(): void {
  if (!installRoot()) return;
  setTimeout(() => void checkForUpdate(), 60_000).unref();
  setInterval(() => void checkForUpdate(), 24 * 3_600_000).unref();
}
