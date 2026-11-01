import "server-only";
import { istanbulToday } from "@/domain/business-days";
import { EVIDENCE_KIND } from "@/domain/records";
import type { OpeningBalanceInput } from "@/lib/schemas/opening-balances";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { blNoTaken } from "./bls";
import { customerForNewName } from "./customers";
import type { Db } from "./db/client";
import { eq } from "drizzle-orm";
import { billsOfLading, containers, customers, documents, requests } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, nameBlDocuments } from "./files";
import { addLedgerEntry } from "./ledger";
import { depositEvidence, validateReferences } from "./payments";

/**
 * Moves an open Excel record into the app (admin only, the stated exception of rules 7 and
 * 11): a B/L without a payment record, whose deposit is an OPENING_BALANCE ledger entry. The
 * original receipt (or invoice) is attached when at hand, or later (rule 12, as for payments).
 * Requests already made outside the app become one sent request with the last attempt number
 * and date, so follow-ups, replies and allocation continue from there; earlier attempts have
 * no row of their own. Request timing is computed on read like any B/L's: without past requests
 * the first request is due the first-request delay after payment, otherwise the follow-up
 * interval after the last request.
 */
export function createOpeningBalance(db: Db, actor: AuthUser, input: OpeningBalanceInput, now: Date = new Date()): number {
  const roleUsed = authorize(actor, "openingBalance.create");
  return db.transaction((tx) => {
    validateReferences(tx, input, now);
    if (input.lastRequestOn !== null) {
      if (input.lastRequestOn > istanbulToday(now)) throw new DomainError("requests.errors.futureDate");
      if (input.lastRequestOn < input.paidAt) throw new DomainError("requests.errors.beforePayment");
    }
    if (blNoTaken(tx, input.blNo)) throw new DomainError("bls.errors.blNoTaken");
    if (input.customerId !== null && !tx.select().from(customers).where(eq(customers.id, input.customerId)).get()?.active) {
      throw new DomainError("customers.errors.unknown");
    }
    const customerId = input.customerId ?? (input.newCustomerName ? customerForNewName(tx, actor, roleUsed, input.newCustomerName, now) : null);

    const at = now.toISOString();
    const status = input.pastAttempts > 0 ? "REQUESTED" : "PAID";
    const bl = tx
      .insert(billsOfLading)
      .values({
        blNo: input.blNo,
        depositPaymentId: null,
        customerId,
        fileNo: input.fileNo,
        agencyId: input.agencyId,
        currency: input.currency,
        depositAmountMinor: input.amountMinor,
        paidAt: input.paidAt,
        status,
        createdBy: actor.id,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    if (input.containers.length > 0) {
      tx.insert(containers).values(input.containers.map((containerNo) => ({ blId: bl.id, containerNo }))).run();
    }
    if (input.documentId !== null) {
      attachDocument(tx, actor, { documentId: input.documentId, kind: EVIDENCE_KIND[input.kind], ownerType: "bill_of_lading", ownerId: bl.id });
    }
    addLedgerEntry(
      tx,
      { blId: bl.id, type: "OPENING_BALANCE", amountMinor: input.amountMinor, currency: input.currency, entryDate: input.paidAt, createdBy: actor.id },
      now,
    );
    if (input.lastRequestOn !== null) {
      tx.insert(requests)
        .values({
          blId: bl.id,
          type: "REFUND",
          channel: "EMAIL",
          attemptNo: input.pastAttempts,
          sendStatus: "SENT",
          requestedOn: input.lastRequestOn,
          sentAt: at,
          createdBy: actor.id,
          createdAt: at,
        })
        .run();
    }
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "openingBalance.create",
        entityType: "bill_of_lading",
        entityId: bl.id,
        after: {
          blNo: bl.blNo,
          agencyId: input.agencyId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          paidAt: input.paidAt,
          kind: input.kind,
          customerId,
          containers: input.containers,
          documentId: input.documentId,
          pastAttempts: input.pastAttempts,
          lastRequestOn: input.lastRequestOn,
          status,
          renamed: nameBlDocuments(tx, bl),
        },
        reason: input.note,
      },
      now,
    );
    return bl.id;
  });
}

/**
 * Attaches the original receipt (or invoice) a migrated B/L was saved without (rule 12, as for
 * payments): once, while the B/L is active. The document keeps the kind it was uploaded as.
 */
export function attachOpeningBalanceEvidence(db: Db, actor: AuthUser, input: { blId: number; documentId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "openingBalance.attachEvidence");
  db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl || bl.depositPaymentId !== null) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("payments.errors.voided");
    if (depositEvidence(tx, bl)) throw new DomainError("payments.errors.evidenceExists");
    const document = tx.select({ kind: documents.kind }).from(documents).where(eq(documents.id, input.documentId)).get();
    if (document?.kind !== "RECEIPT" && document?.kind !== "INVOICE") throw new DomainError("files.errors.evidence");
    attachDocument(tx, actor, { documentId: input.documentId, kind: document.kind, ownerType: "bill_of_lading", ownerId: bl.id });
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "openingBalance.attachEvidence",
        entityType: "bill_of_lading",
        entityId: bl.id,
        after: { documentId: input.documentId, renamed: nameBlDocuments(tx, bl) },
      },
      now,
    );
  });
}
