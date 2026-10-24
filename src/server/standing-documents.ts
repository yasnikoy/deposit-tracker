import "server-only";
import { desc, eq } from "drizzle-orm";
import { STANDING_DOCUMENT_SLOTS, type StandingDocumentSlot } from "@/domain/records";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { documents, standingDocuments } from "./db/schema";
import { attachDocument } from "./files";

export type StandingDocument = {
  slot: StandingDocumentSlot;
  documentId: number;
  originalName: string;
  sizeBytes: number;
  uploadedAt: string;
};

/** The current document per slot: the newest upload replaces older ones for future emails. */
export function currentStandingDocuments(db: DbOrTx): StandingDocument[] {
  return STANDING_DOCUMENT_SLOTS.flatMap((slot) => {
    const row = db
      .select({
        slot: standingDocuments.slot,
        documentId: standingDocuments.documentId,
        originalName: documents.originalName,
        sizeBytes: documents.sizeBytes,
        uploadedAt: standingDocuments.uploadedAt,
      })
      .from(standingDocuments)
      .innerJoin(documents, eq(documents.id, standingDocuments.documentId))
      .where(eq(standingDocuments.slot, slot))
      .orderBy(desc(standingDocuments.id))
      .get();
    return row ? [row] : [];
  });
}

export function listStandingDocuments(db: DbOrTx, actor: AuthUser): StandingDocument[] {
  authorize(actor, "standingDocument.view");
  return currentStandingDocuments(db);
}

/** Admin uploads the signature circular or power of attorney once; applies to all agencies. */
export function setStandingDocument(
  db: Db,
  actor: AuthUser,
  input: { slot: StandingDocumentSlot; documentId: number },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "standingDocument.manage");
  db.transaction((tx) => {
    const previous = currentStandingDocuments(tx).find((d) => d.slot === input.slot) ?? null;
    const row = tx
      .insert(standingDocuments)
      .values({ slot: input.slot, documentId: input.documentId, uploadedBy: actor.id, uploadedAt: now.toISOString() })
      .returning()
      .get();
    const doc = attachDocument(tx, actor, { documentId: input.documentId, kind: "STANDING", ownerType: "standing_document", ownerId: row.id });
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "standingDocument.set",
        entityType: "standing_document",
        entityId: input.slot,
        before: previous ? { documentId: previous.documentId, originalName: previous.originalName } : null,
        after: { documentId: doc.id, originalName: doc.originalName },
      },
      now,
    );
  });
}
