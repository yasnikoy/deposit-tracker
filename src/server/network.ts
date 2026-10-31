import "server-only";
import os from "node:os";

/** Private-network ranges, most common office first. */
const RANK = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * The PC's office-network IPv4 addresses, best first. Office PCs all carry the same name
 * ("UserPC"), so the team reaches the app by address, not by computer name.
 */
export function lanAddresses(): string[] {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
    .map((a) => a.address);
  const rank = (address: string) => {
    const i = RANK.findIndex((r) => r.test(address));
    return i === -1 ? RANK.length : i;
  };
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b));
}

/** Where the team opens the app, e.g. http://192.168.1.20:3000. */
export function appBaseUrl(): string {
  return `http://${lanAddresses()[0] ?? os.hostname()}:${process.env.PORT ?? "3000"}`;
}
