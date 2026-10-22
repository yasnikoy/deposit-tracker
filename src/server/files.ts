import "server-only";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { DocumentKind } from "@/domain/records";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { documents } from "./db/schema";
import { getEnv } from "./env";
import { DomainError } from "./errors";
import { getSetting } from "./settings";

export type StoredDocument = typeof documents.$inferSelect;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  eml: "message/rfc822",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Content must match the extension for formats with a fixed signature.
const SIGNATURES: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],
  doc: [[0xd0, 0xcf, 0x11, 0xe0]],
  xls: [[0xd0, 0xcf, 0x11, 0xe0]],
};

export function filesRoot(): string {
  return path.join(/*turbopackIgnore: true*/ getEnv().dataDir, "files");
}

export function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** Keeps only a safe display name; the stored file name is always generated. */
function cleanOriginalName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  return base.slice(0, 200) || "dosya";
}

/** Stores an uploaded file in the data folder and records it as an unattached document. */
export function storeUpload(
  db: Db,
  actor: AuthUser,
  input: { originalName: string; content: Buffer; kind: DocumentKind },
  now: Date = new Date(),
): StoredDocument {
  const roleUsed = authorize(actor, "document.upload");
  const originalName = cleanOriginalName(input.originalName);
  const extension = extensionOf(originalName);
  const allowed = getSetting("rules.allowedFileTypes", {}, db);
  if (!allowed.includes(extension)) throw new DomainError("files.errors.type", { types: allowed.join(", ") });
  const maxMb = getSetting("rules.maxFileSizeMb", {}, db);
  if (input.content.length === 0) throw new DomainError("files.errors.empty");
  if (input.content.length > maxMb * 1024 * 1024) throw new DomainError("files.errors.size", { max: maxMb });
  const signatures = SIGNATURES[extension];
  if (signatures && !signatures.some((sig) => sig.every((byte, i) => input.content[i] === byte))) {
    throw new DomainError("files.errors.content");
  }

  const month = now.toISOString().slice(0, 7).replace("-", "/");
  const storedPath = `${month}/${randomUUID()}.${extension}`;
  const target = path.join(/*turbopackIgnore: true*/ filesRoot(), storedPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.part`;
  fs.writeFileSync(temp, input.content, { flag: "wx" });
  fs.renameSync(temp, target);

  try {
    return db.transaction((tx) => {
      const row = tx
        .insert(documents)
        .values({
          kind: input.kind,
          originalName,
          storedPath,
          mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
          sizeBytes: input.content.length,
          sha256: createHash("sha256").update(input.content).digest("hex"),
          uploadedBy: actor.id,
          uploadedAt: now.toISOString(),
        })
        .returning()
        .get();
      writeAudit(
        tx,
        {
          actorUserId: actor.id,
          roleUsed,
          action: "document.upload",
          entityType: "document",
          entityId: row.id,
          after: { kind: row.kind, originalName, sizeBytes: row.sizeBytes, sha256: row.sha256 },
        },
        now,
      );
      return row;
    });
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
}

/**
 * Attaches an uploaded, still unattached document of the expected kind to its record.
 * Only the uploader can attach it, so nobody can claim someone else's file.
 */
export function attachDocument(
  tx: DbOrTx,
  actor: AuthUser,
  input: { documentId: number; kind: DocumentKind; ownerType: string; ownerId: number },
): StoredDocument {
  const doc = tx.select().from(documents).where(eq(documents.id, input.documentId)).get();
  if (!doc || doc.kind !== input.kind || doc.uploadedBy !== actor.id) throw new DomainError("files.errors.evidence");
  const updated = tx
    .update(documents)
    .set({ ownerType: input.ownerType, ownerId: input.ownerId })
    .where(and(eq(documents.id, input.documentId), isNull(documents.ownerId)))
    .returning()
    .get();
  if (!updated) throw new DomainError("files.errors.evidence");
  return updated;
}

export function getDocument(db: DbOrTx, actor: AuthUser, id: number): StoredDocument {
  authorize(actor, "document.view");
  const doc = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!doc) throw new DomainError("errors.notFound");
  return doc;
}

export function documentPath(doc: StoredDocument): string {
  const root = filesRoot();
  const full = path.resolve(/*turbopackIgnore: true*/ root, doc.storedPath);
  if (!full.startsWith(root + path.sep)) throw new Error("Document path escapes the files folder");
  return full;
}
