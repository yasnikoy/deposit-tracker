import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, InstanceLockError } from "@/server/instance-lock";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-lock-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lockFile = () => path.join(dir, "app.lock");

describe("acquireInstanceLock", () => {
  it("creates the lock file with our pid and removes it on release", () => {
    const lock = acquireInstanceLock(dir);
    expect(fs.readFileSync(lockFile(), "utf8")).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("refuses to start while another live process holds the lock", () => {
    fs.writeFileSync(lockFile(), String(process.ppid));
    expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockError);
  });

  it("takes over a stale lock left by a dead process", () => {
    fs.writeFileSync(lockFile(), "999999999");
    acquireInstanceLock(dir).release();
  });
});
