import "server-only";
import fs from "node:fs";
import path from "node:path";

export class InstanceLockError extends Error {
  constructor(public readonly pid: number) {
    super(`Another instance of the app is already running (pid ${pid})`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-instance guard: only one app process may open the database.
 * A lock left behind by a crashed process (pid no longer alive) is taken over.
 */
export function acquireInstanceLock(dataDir: string): { release: () => void } {
  const lockFile = path.join(/*turbopackIgnore: true*/ dataDir, "app.lock");
  fs.mkdirSync(dataDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try {
          if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile);
        } catch {
          // Already gone.
        }
      };
      process.once("exit", release);
      return { release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
      if (pid === process.pid) return { release: () => {} };
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) throw new InstanceLockError(pid);
      fs.unlinkSync(lockFile);
    }
  }
  throw new Error(`Could not acquire instance lock at ${lockFile}`);
}
