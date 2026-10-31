import { getDb } from "@/server/db/client";
import { probe } from "@/server/health";
import { logger } from "@/server/logger";

// Public on purpose (no session): start.cmd checks it after an update. It reveals only the version.
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(probe(getDb()));
  } catch (error) {
    logger.error({ err: error }, "health probe failed");
    return Response.json({ ok: false }, { status: 503 });
  }
}
