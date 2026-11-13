import "server-only";
import { istanbulToday } from "@/domain/business-days";
import { EVIDENCE_KIND } from "@/domain/records";
import type { OpeningBalanceInput } from "@/lib/schemas/opening-balances";
import { agencyForNewName } from "./agencies";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { customerForNewName } from "./customers";
import type { Db } from "./db/client";
import { eq } from "drizzle-orm";
import { billsOfLading, customers, documents, requests } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, nameBlDocuments } from "./files";
import { addLedgerEntry } from "./ledger";
import { addDepositToBl, existingBlFor, findDuplicates, missingOpeningEvidence, validateReferences, type DuplicateCandidate } from "./payments";
import { getSetting } from "./settings";

export type CreateOpeningBalanceResult =
  | { status: "created"; blId: number; /** The deposit joined this existing B/L. */ joined: boolean }
  | { status: "duplicate"; duplicates: DuplicateCandidate[] };

/**
 * Moves an open Excel record into the app (admin only, the stated exception of rules 7 and
 * 11): a B/L without a payment record, whose deposit is an OPENING_BALANCE ledger entry. The
 * original receipt (or invoice) is attached when at hand, or later (rule 12, as for payments).
 * Requests already made outside the app become one sent request with the last attempt number
 * and date, so follow-ups, replies and allocation continue from there; earlier attempts have
 * no row of their own. Request timing is computed on read like any B/L's: without past requests
 * the first request is due the first-request delay after payment, otherwise the follow-up
 * interval after the last request.
 *
 * A B/L number that an active B/L already has adds the deposit to that B/L instead (an
 * additional deposit, as on a payment): same agency and currency, the B/L still open. The B/L
 * keeps its own request history, customer, file number and containers, so the record brings
 * none of them. With the duplicate-warning setting on, a deposit with the same agency, amount,
 * currency and date is reported back and saved only once the user confirms.
 */
export function createOpeningBalance(db: Db, actor: AuthUser, input: OpeningBalanceInput, now: Date = new Date()): CreateOpeningBalanceResult {
  const roleUsed = authorize(actor, "openingBalance.create");
  return db.transaction((tx): CreateOpeningBalanceResult => {
    const agencyId = input.agencyId ?? agencyForNewName(tx, actor, "agency.createFromOpeningBalance", input.newAgencyName ?? "", now);
    validateReferences(tx, { ...input, agencyId }, now);
    if (!input.confirmDuplicate && getSetting("rules.duplicateWarning", {}, tx)) {
      const duplicates = findDuplicates(tx, { ...input, agencyId });
      if (duplicates.length > 0) return { status: "duplicate", duplicates };
    }

    const existing = existingBlFor(tx, input.blNo, { agencyId, currency: input.currency });
    if (existing) {
      if (input.pastAttempts > 0 || input.fileNo !== null || input.customerId !== null || input.newCustomerName) {
        throw new DomainError("openingBalances.errors.joinFields", { bl: existing.blNo });
      }
      if (input.documentId !== null) {
        attachDocument(tx, actor, { documentId: input.documentId, kind: EVIDENCE_KIND[input.kind], ownerType: "bill_of_lading", ownerId: existing.id });
      }
      addDepositToBl(
        tx,
        actor,
        roleUsed,
        existing,
        { type: "OPENING_BALANCE", amountMinor: input.amountMinor, currency: input.currency, entryDate: input.paidAt, depositPaymentId: null },
        { action: "bl.additionalOpeningBalance", after: { kind: input.kind, documentId: input.documentId, ...(input.confirmDuplicate ? { duplicateConfirmed: true } : {}) }, reason: input.note },
        now,
      );
      return { status: "created", blId: existing.id, joined: true };
    }
    if (input.lastRequestOn !== null) {
      if (input.lastRequestOn > istanbulToday(now)) throw new DomainError("requests.errors.futureDate");
      if (input.lastRequestOn < input.paidAt) throw new DomainError("requests.errors.beforePayment", { bl: input.blNo });
    }
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
        // "Açıklama" on the form: the B/L's description (and the audit reason, as before).
        description: input.note,
        agencyId,
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
          agencyId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          paidAt: input.paidAt,
          kind: input.kind,
          customerId,
          documentId: input.documentId,
          pastAttempts: input.pastAttempts,
          lastRequestOn: input.lastRequestOn,
          status,
          renamed: nameBlDocuments(tx, bl),
          ...(input.confirmDuplicate ? { duplicateConfirmed: true } : {}),
        },
        reason: input.note,
      },
      now,
    );
    return { status: "created", blId: bl.id, joined: false };
  });
}

/**
 * Attaches the original receipt (or invoice) an opening balance was saved without (rule 12, as
 * for payments): one per opening balance, while the B/L is active. The document keeps the kind
 * it was uploaded as.
 */
export function attachOpeningBalanceEvidence(db: Db, actor: AuthUser, input: { blId: number; documentId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "openingBalance.attachEvidence");
  db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("payments.errors.voided");
    if (missingOpeningEvidence(tx, bl.id) === 0) throw new DomainError("payments.errors.evidenceExists");
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
