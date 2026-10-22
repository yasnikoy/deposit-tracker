// Rule 15: live data must never end up in a build. Fails the build if the
// standalone output contains a data folder or any SQLite / backup file.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".next/standalone");
const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (dir === root && /^data(-|$)/.test(entry.name)) offenders.push(rel);
      else if (entry.name !== "node_modules") walk(full);
    } else if (/\.(sqlite|sqlite-wal|sqlite-shm|lock|key)$/.test(entry.name)) {
      offenders.push(rel);
    }
  }
}

if (!fs.existsSync(root)) {
  console.error("check-build: .next/standalone not found");
  process.exit(1);
}
walk(root);
if (offenders.length > 0) {
  console.error(`check-build: runtime data found in the build output:\n  ${offenders.join("\n  ")}`);
  process.exit(1);
}
console.log("check-build: no runtime data in the build output.");
