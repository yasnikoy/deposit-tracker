/**
 * Takes a backup now, the same as the daily one (backup.cmd). Safe while the app runs: SQLite's
 * online backup reads a consistent copy. Usage: backup
 */
import fs from "node:fs";
import path from "node:path";
import { runBackup } from "@/server/backups";
import { DATABASE_FILE_NAME, getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";

async function main() {
  const { dataDir } = getEnv();
  if (!fs.existsSync(path.join(dataDir, DATABASE_FILE_NAME))) throw new Error(`No database in ${dataDir}`);
  const result = await runBackup(getDb(), dataDir);
  console.log(`Yedek alındı: ${result.local.file} (${result.local.filesCopied} yeni dosya)`);
  if (result.second && "error" in result.second) {
    console.error(`İkinci konuma yazılamadı: ${result.second.error}`);
    process.exitCode = 2;
  } else if (result.second) {
    console.log(`İkinci konum: ${result.second.file}`);
  } else {
    console.log("İkinci yedek konumu ayarlanmamış (Ayarlar → Yedekleme).");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
