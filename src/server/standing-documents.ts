import "server-only";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { STANDING_DOCUMENT_SLOTS, type StandingDocumentSlot } from "@/domain/records";
import { t } from "@/i18n";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { customers, documents, standingDocuments } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, extensionOf } from "./files";

export type StandingDocument = {
  slot: StandingDocumentSlot;
  documentId: number;
  originalName: string;
  sizeBytes: number;
  uploadedAt: string;
};

/**
 * The current signature circular and power of attorney of each given customer (all when
 * omitted): the newest upload per slot replaces older ones for future emails.
 */
export function customerStandingDocuments(db: DbOrTx, customerIds?: number[]): Map<number, StandingDocument[]> {
  const rows = db
    .select({
      id: standingDocuments.id,
      customerId: standingDocuments.customerId,
      slot: standingDocuments.slot,
      documentId: standingDocuments.documentId,
      originalName: documents.originalName,
      sizeBytes: documents.sizeBytes,
      uploadedAt: standingDocuments.uploadedAt,
    })
    .from(standingDocuments)
    .innerJoin(documents, eq(documents.id, standingDocuments.documentId))
    .where(and(isNotNull(standingDocuments.customerId), customerIds ? inArray(standingDocuments.customerId, customerIds) : undefined))
    .orderBy(desc(standingDocuments.id))
    .all();
  const map = new Map<number, StandingDocument[]>();
  for (const { id: _id, customerId, ...doc } of rows) {
    const current = map.get(customerId!) ?? [];
    if (!current.some((d) => d.slot === doc.slot)) current.push(doc);
    map.set(customerId!, current);
  }
  for (const [customerId, docs] of map) map.set(customerId, STANDING_DOCUMENT_SLOTS.flatMap((slot) => docs.filter((d) => d.slot === slot)));
  return map;
}

/** The slots a customer has no document for yet. */
export function missingStandingSlots(docs: StandingDocument[] | undefined): StandingDocumentSlot[] {
  return STANDING_DOCUMENT_SLOTS.filter((slot) => !docs?.some((d) => d.slot === slot));
}

/** The documents shown on the customer cards. */
export function listCustomerStandingDocuments(db: DbOrTx, actor: AuthUser): Record<number, StandingDocument[]> {
  authorize(actor, "standingDocument.view");
  return Object.fromEntries(customerStandingDocuments(db));
}

/**
 * Operations or an admin uploads a customer's signature circular or power of attorney on its
 * card. It is named after its slot ("İmza sirküleri.pdf"), so agencies receive that name;
 * the uploaded name stays in the audit log. A newer upload replaces the old one for future emails.
 */
export function setStandingDocument(
  db: Db,
  actor: AuthUser,
  input: { customerId: number; slot: StandingDocumentSlot; documentId: number },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "standingDocument.manage");
  db.transaction((tx) => {
    if (!tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).get()) throw new DomainError("errors.notFound");
    const previous = customerStandingDocuments(tx, [input.customerId]).get(input.customerId)?.find((d) => d.slot === input.slot) ?? null;
    const row = tx
      .insert(standingDocuments)
      .values({ customerId: input.customerId, slot: input.slot, documentId: input.documentId, uploadedBy: actor.id, uploadedAt: now.toISOString() })
      .returning()
      .get();
    const doc = attachDocument(tx, actor, { documentId: input.documentId, kind: "STANDING", ownerType: "standing_document", ownerId: row.id });
    const name = `${t(`standing.slots.${input.slot}`)}.${extensionOf(doc.originalName)}`;
    tx.update(documents).set({ originalName: name }).where(eq(documents.id, doc.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "standingDocument.set",
        entityType: "customer",
        entityId: input.customerId,
        before: previous ? { slot: input.slot, documentId: previous.documentId } : null,
        after: { slot: input.slot, documentId: doc.id, uploadedName: doc.originalName, originalName: name },
      },
      now,
    );
  });
}
