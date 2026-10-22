import type { NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { DomainError, ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { logger } from "@/server/logger";
import { enqueueReceipt, prefillFromExtraction } from "@/server/payments";
import { parseReceipt } from "@/server/receipts/parser";

// Uploads bypass the proxy (see proxy.ts) so large files are not buffered there;
// authentication and can() run here.
const fieldsSchema = z.object({
  kind: z.enum(["RECEIPT", "INVOICE"]),
  queue: z.enum(["0", "1"]).default("0"),
});

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) return Response.json({ ok: false, error: "errors.forbidden" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const fields = fieldsSchema.safeParse({ kind: form.get("kind"), queue: form.get("queue") ?? undefined });
  if (!(file instanceof File) || !fields.success) {
    return Response.json({ ok: false, error: "errors.validation" }, { status: 400 });
  }

  try {
    const db = getDb();
    const content = Buffer.from(await file.arrayBuffer());
    const document = storeUpload(db, session.user, { originalName: file.name, content, kind: fields.data.kind });
    const extraction = fields.data.kind === "RECEIPT" ? parseReceipt(content, document.mimeType) : { parser: "none" };

    if (fields.data.queue === "1") {
      const queueItemId = enqueueReceipt(db, session.user, document, extraction);
      return Response.json({ ok: true, queueItemId });
    }
    return Response.json({
      ok: true,
      document: { id: document.id, originalName: document.originalName },
      prefill: prefillFromExtraction(db, extraction),
      parser: extraction.parser,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return Response.json({ ok: false, error: error.messageKey }, { status: 403 });
    if (error instanceof DomainError) {
      return Response.json({ ok: false, error: error.messageKey, params: error.params }, { status: 400 });
    }
    logger.error({ err: error }, "upload failed");
    return Response.json({ ok: false, error: "files.errors.upload" }, { status: 500 });
  }
}
