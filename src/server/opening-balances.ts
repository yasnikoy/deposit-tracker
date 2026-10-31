import "server-only";
import { istanbulToday } from "@/domain/business-days";
import { EVIDENCE_KIND } from "@/domain/records";
import type { OpeningBalanceInput } from "@/lib/schemas/opening-balances";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { blNoTaken } from "./bls";
import type { Db } from "./db/client";
import { eq } from "drizzle-orm";
import { billsOfLading, containers, customers, requests } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, nameBlDocuments } from "./files";
import { addLedgerEntry } from "./ledger";
import { validateReferences } from "./payments";

/**
 * Moves an open Excel record into the app (admin only, the stated exception of rules 7 and
 * 11): a B/L without a payment record, whose deposit is an OPENING_BALANCE ledger entry and
 * whose original receipt (or invoice) is mandatory (rule 12). Requests already made outside
 * the app become one sent request with the last attempt number and date, so follow-ups,
 * replies and allocation continue from there; earlier attempts have no row of their own.
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

    const at = now.toISOString();
    const status = input.pastAttempts > 0 ? "REQUESTED" : "PAID";
    const bl = tx
      .insert(billsOfLading)
      .values({
        blNo: input.blNo,
        depositPaymentId: null,
        customerId: input.customerId,
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
    attachDocument(tx, actor, { documentId: input.documentId, kind: EVIDENCE_KIND[input.kind], ownerType: "bill_of_lading", ownerId: bl.id });
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
