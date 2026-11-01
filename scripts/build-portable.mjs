// Builds the Windows x64 portable zip (ARCHITECTURE → Packaging): a portable Node.js, the
// Next.js standalone build with Windows native modules, the command-line tools bundled with
// esbuild, and the .cmd/.ps1 scripts. Usage: pnpm build:portable [--skip-build]
//
// The zip holds one `DepositTracker` folder, to be unpacked anywhere (Desktop, Documents): the
// launchers and BENIOKU.txt at its top, the program in `app`; setup.cmd adds `data`. Downloads are
// verified (Node.js against nodejs.org's SHASUMS256.txt, npm packages against the registry's
// integrity hash) and cached outside the repository.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const NODE_VERSION = process.version; // the same Node.js the project is pinned to (mise)
const CACHE = path.join(os.homedir(), ".cache", "deposit-tracker-build");
const OUT_ROOT = path.join(ROOT, "dist");
const NAME = `deposit-tracker-${VERSION}-win-x64`;
const STAGE = path.join(OUT_ROOT, NAME);
const PKG = path.join(STAGE, "DepositTracker"); // the folder the user unpacks
const APP = path.join(PKG, "app"); // the program folder, replaced by updates
const ZIP = path.join(OUT_ROOT, `${NAME}.zip`);

const log = (message) => console.log(`build:portable: ${message}`);
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest();

async function download(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, url.replace(/[^A-Za-z0-9._-]+/g, "_"));
  if (fs.existsSync(file)) return fs.readFileSync(file);
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

/** Node.js for Windows x64, checked against the official SHA-256 list. */
async function nodeExe() {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const zipName = `node-${NODE_VERSION}-win-x64.zip`;
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString("utf8");
  const expected = sums.split("\n").find((l) => l.trim().endsWith(` ${zipName}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`${zipName} not in SHASUMS256.txt`);
  const zip = await download(`${base}/${zipName}`);
  if (sha("sha256", zip).toString("hex") !== expected) throw new Error(`${zipName}: SHA-256 mismatch`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "node-win-"));
  fs.writeFileSync(path.join(tmp, zipName), zip);
  execFileSync("bsdtar", ["-xf", zipName], { cwd: tmp });
  return path.join(tmp, `node-${NODE_VERSION}-win-x64`);
}

/** An npm package tarball, checked against the registry's integrity hash, unpacked to `dest`. */
async function npmPackage(name, version, dest) {
  const meta = JSON.parse((await download(`https://registry.npmjs.org/${name}/${version}`)).toString("utf8"));
  const tgz = await download(meta.dist.tarball);
  const [algo, b64] = meta.dist.integrity.split("-");
  if (sha(algo, tgz).toString("base64") !== b64) throw new Error(`${name}@${version}: integrity mismatch`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "npm-pkg-"));
  fs.writeFileSync(path.join(tmp, "p.tgz"), tgz);
  execFileSync("bsdtar", ["-xzf", "p.tgz"], { cwd: tmp });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(tmp, "package"), dest, { recursive: true });
}

/** Version of a package as installed for the build. */
const installedVersion = (name) =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(execFileSync("node", ["-p", `require.resolve("${name}/package.json")`], { cwd: ROOT }).toString().trim()), "package.json"), "utf8")).version;

function writeText(file, text, { crlf = false, bom = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  fs.writeFileSync(file, bom ? `\uFEFF${body}` : body);
}

async function main() {
  if (!process.argv.includes("--skip-build")) execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit" });
  const standalone = path.join(ROOT, ".next", "standalone");
  if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("no standalone build; run without --skip-build");

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });
  const server = path.join(APP, "server");

  // The standalone build without symlinks: extracting them on Windows needs admin rights or
  // Developer Mode. fs.cpSync's `dereference` only follows the top-level path, so `cp -L`.
  log("copying the standalone build");
  fs.mkdirSync(APP, { recursive: true });
  execFileSync("cp", ["-RL", standalone, server]);
  // A dereferenced copy no longer finds its dependencies through the symlink's real path
  // (Next's hashed aliases in .next/node_modules, pnpm's top-level links). Moving pnpm's
  // hoisted set (.pnpm/node_modules) to the top level makes them resolvable from anywhere.
  const hoisted = path.join(server, "node_modules", ".pnpm", "node_modules");
  for (const entry of fs.readdirSync(hoisted)) {
    const names = entry.startsWith("@") ? fs.readdirSync(path.join(hoisted, entry)).map((n) => `${entry}/${n}`) : [entry];
    for (const name of names) {
      const dest = path.join(server, "node_modules", name);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(hoisted, name), dest);
    }
  }
  fs.cpSync(path.join(ROOT, ".next", "static"), path.join(server, ".next", "static"), { recursive: true });
  if (fs.existsSync(path.join(ROOT, "public"))) fs.cpSync(path.join(ROOT, "public"), path.join(server, "public"), { recursive: true });

  // Native modules for Windows x64. better-sqlite3 ships its Windows prebuild in the package; it
  // also gets a top-level folder so the bundled tools find it. argon2 needs its Windows package.
  const pnpmDir = path.join(server, "node_modules", ".pnpm");
  const sqliteDir = fs.readdirSync(pnpmDir).find((d) => d.startsWith("better-sqlite3@"));
  const sqlite = path.join(pnpmDir, sqliteDir, "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(sqlite, "prebuilds", "win32-x64.node"))) throw new Error("better-sqlite3 has no win32-x64 prebuild");
  fs.cpSync(sqlite, path.join(server, "node_modules", "better-sqlite3"), { recursive: true });
  const argon2Version = installedVersion("@node-rs/argon2");
  await npmPackage("@node-rs/argon2-win32-x64-msvc", argon2Version, path.join(server, "node_modules", "@node-rs", "argon2-win32-x64-msvc"));
  // Binaries for other systems are dead weight on Windows: whole packages for another OS or CPU
  // (sharp's Linux builds and libvips, argon2-linux-x64-gnu), then stray .node files.
  for (const file of execFileSync("find", [server, "-name", "package.json"]).toString().trim().split("\n")) {
    if (!fs.existsSync(file)) continue; // inside a package removed earlier in the loop
    let meta;
    try { meta = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const excludes = (list, value) => Array.isArray(list) && !list.some((v) => v === value || (v.startsWith("!") && v !== `!${value}`));
    if (excludes(meta.os, "win32") || excludes(meta.cpu, "x64")) fs.rmSync(path.dirname(file), { recursive: true });
  }
  for (const file of execFileSync("find", [server, "-name", "*.node"]).toString().trim().split("\n")) {
    if (file && !/win32-x64/.test(file)) fs.rmSync(file);
  }
  execFileSync("find", [server, "-path", "*/node_modules/*", "-type", "d", "-empty", "-delete"]);

  // Command-line tools (create-admin, backup), bundled so they run with the portable Node.js.
  log("bundling tools");
  await esbuild.build({
    entryPoints: { "create-admin": "scripts/create-admin.ts", backup: "scripts/backup.ts" },
    outdir: path.join(server, "tools"),
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    conditions: ["react-server"],
    // Native or dynamically loading packages stay outside; the server's node_modules has them.
    external: ["better-sqlite3", "@node-rs/argon2", "pino", "pino-roll", "pdfjs-dist"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });

  // Portable Node.js: node.exe and its license.
  const nodeDir = await nodeExe();
  fs.mkdirSync(path.join(APP, "node"), { recursive: true });
  for (const f of ["node.exe", "LICENSE"]) fs.copyFileSync(path.join(nodeDir, f), path.join(APP, "node", f));

  // Scripts: .cmd in CRLF and plain ASCII; .ps1 as UTF-8 with BOM so Windows PowerShell reads Turkish.
  // The launchers and BENIOKU.txt sit at the top of the folder, the PowerShell scripts in app.
  const win = path.join(ROOT, "packaging", "windows");
  for (const f of fs.readdirSync(win)) {
    const src = path.join(win, f);
    if (fs.statSync(src).isDirectory()) continue;
    writeText(path.join(PKG, f), fs.readFileSync(src, "utf8"), { crlf: true, bom: f.endsWith(".txt") });
  }
  for (const f of fs.readdirSync(path.join(win, "scripts"))) {
    writeText(path.join(APP, "scripts", f), fs.readFileSync(path.join(win, "scripts", f), "utf8"), { crlf: true, bom: f.endsWith(".ps1") });
  }
  writeText(path.join(APP, "VERSION"), `${VERSION}\n`);

  // Rule 15 once more, on the final folder: no data, keys or databases.
  const offenders = execFileSync("find", [STAGE, "(", "-iname", "*.sqlite*", "-o", "-iname", "*.key", "-o", "-iname", "app.lock", "-o", "-path", "*/data/*", ")"]).toString().trim();
  if (offenders) throw new Error(`runtime data in the package:\n${offenders}`);
  const links = execFileSync("find", [STAGE, "-type", "l"]).toString().trim();
  if (links) throw new Error(`symbolic links in the package (Windows cannot extract them):\n${links}`);

  log("zipping");
  execFileSync("bsdtar", ["-a", "-cf", ZIP, "-C", STAGE, "."]);
  const digest = sha("sha256", fs.readFileSync(ZIP)).toString("hex");
  fs.writeFileSync(`${ZIP}.sha256`, `${digest}  ${path.basename(ZIP)}\n`);
  log(`${path.relative(ROOT, ZIP)} (${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MB) sha256 ${digest}`);
}

main().catch((error) => {
  console.error(`build:portable: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
