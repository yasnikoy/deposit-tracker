// Signs the portable zip of the current version and publishes it as a GitHub release
// (ARCHITECTURE → Updates). Usage:
//   pnpm release              check and sign, show what would be published (nothing is uploaded)
//   pnpm release --publish    the same, then create the GitHub release with zip, .sig and .sha256
// The private key never leaves this machine: RELEASE_KEY or ~/.config/deposit-tracker/release-private-key.pem.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const tag = `v${version}`;
const zip = path.join(ROOT, "dist", `deposit-tracker-${version}-win-x64.zip`);
const keyFile = process.env.RELEASE_KEY ?? path.join(os.homedir(), ".config", "deposit-tracker", "release-private-key.pem");
const publish = process.argv.includes("--publish");

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const git = (...args) => execFileSync("git", args, { cwd: ROOT }).toString().trim();

if (!fs.existsSync(zip)) fail(`${path.relative(ROOT, zip)} not found; run pnpm build:portable first`);
const packaged = execFileSync("bsdtar", ["-xOf", zip, "./DepositTracker/app/VERSION"]).toString().trim();
if (packaged !== version) fail(`the zip holds version ${packaged}, package.json says ${version}; rebuild it`);
if (git("status", "--porcelain", "--untracked-files=no", "--", "src", "scripts", "packaging", "drizzle", "seed", "package.json")) fail("uncommitted changes in the app; commit them first");
if (git("tag", "--list", tag) !== tag) fail(`tag ${tag} is missing`);
if (git("rev-list", "-n", "1", tag) !== git("rev-parse", "HEAD")) fail(`tag ${tag} is not the current commit`);

// Versions belong to releases (ARCHITECTURE → Change log): what is released must have left
// "Unreleased" for an entry titled with this version.
const unreleased = (fs.readFileSync(path.join(ROOT, "docs", "ARCHITECTURE.md"), "utf8").split("## Change log")[1] ?? "")
  .split(/\n(?=\*\*)/)
  .find((e) => e.startsWith("**Unreleased**"));
const pending = (unreleased ?? "").split("\n").filter((l) => l.startsWith("- ") && l.trim() !== "- Nothing yet.");
if (pending.length > 0) fail(`the change log still lists changes under "Unreleased"; move them into the ${tag} entry first`);

// Sign, and check against the public key the app has built in.
if (!fs.existsSync(keyFile)) fail(`release key not found: ${keyFile}`);
const data = fs.readFileSync(zip);
const signature = crypto.sign(null, data, crypto.createPrivateKey(fs.readFileSync(keyFile)));
const builtIn = /RELEASE_PUBLIC_KEY = `([^`]+)`/.exec(fs.readFileSync(path.join(ROOT, "src", "server", "release.ts"), "utf8"))?.[1];
if (!builtIn || !crypto.verify(null, data, crypto.createPublicKey(builtIn), signature)) fail("the signature does not verify with the app's built-in public key; wrong release key?");
fs.writeFileSync(`${zip}.sig`, signature);
const sha256 = crypto.createHash("sha256").update(data).digest("hex");
fs.writeFileSync(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);

// Release notes: the change-log entries of this version.
const changeLog = fs.readFileSync(path.join(ROOT, "docs", "ARCHITECTURE.md"), "utf8").split("## Change log")[1] ?? "";
const entries = changeLog.split(/\n(?=\*\*)/).filter((e) => e.startsWith("**") && e.split("\n")[0].includes(tag));
if (entries.length === 0) fail(`no change-log entry for ${tag} in docs/ARCHITECTURE.md`);
const notes = `${entries.join("\n").trim()}\n\nSHA-256: ${sha256}\n`;

console.log(`release: ${tag} signed (${(data.length / 1048576).toFixed(1)} MB, sha256 ${sha256})`);
if (!publish) {
  console.log(`release: dry run. Would publish ${tag} with:\n  ${path.basename(zip)}\n  ${path.basename(zip)}.sig\n  ${path.basename(zip)}.sha256\n--- notes ---\n${notes}`);
  process.exit(0);
}
if (git("ls-remote", "--tags", "origin", tag) === "") execFileSync("git", ["push", "origin", tag], { cwd: ROOT, stdio: "inherit" });
const notesFile = path.join(os.tmpdir(), `release-notes-${version}.md`);
fs.writeFileSync(notesFile, notes);
execFileSync("gh", ["release", "create", tag, zip, `${zip}.sig`, `${zip}.sha256`, "--title", `Deposit Tracker ${version}`, "--notes-file", notesFile, "--verify-tag"], { cwd: ROOT, stdio: "inherit" });
console.log(`release: ${tag} published`);
