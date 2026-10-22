import fs from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { getCurrentSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { documentPath, getDocument } from "@/server/files";

// Shown in the browser; other types (e-mail, Office files) are downloaded.
const INLINE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) return new Response(null, { status: 401 });
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response(null, { status: 404 });

  try {
    const doc = getDocument(getDb(), session.user, id);
    const file = documentPath(doc);
    if (!fs.existsSync(file)) return new Response(null, { status: 404 });
    const disposition = INLINE_TYPES.has(doc.mimeType) ? "inline" : "attachment";
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Length": String(doc.sizeBytes),
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response(null, { status: error.messageKey === "errors.forbidden" ? 403 : 404 });
    throw error;
  }
}
