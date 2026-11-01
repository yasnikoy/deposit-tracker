import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import { recordAccountingEntry } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { auditLog, billsOfLading } from "@/server/db/schema";
import { recordStatementDeductions } from "@/server/deductions";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { createPayment } from "@/server/payments";
import { createRefund } from "@/server/refunds";
import { positions } from "@/server/reports";
import { recordPortalRequest } from "@/server/requests";
import { undoActions } from "@/server/undo";
import { listDeductionTypes } from "@/server/lists";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const usd = (amount: number) => amount * 100;

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let line: number;

const status = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.status;

/** A B/L whose first refund request was recorded (on the portal) on 1 Sep. */
function requestedBl(blNo: string, amount: number): number {
  const { blId } = makeBl(db, { acc, ops }, { agencyId: line, blNo, paidAt: "2026-08-03", amountMinor: usd(amount) }, NOW);
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
  recordPortalRequest(db, ops, { blId, requestedOn: "2026-09-01", portalRef: null }, NOW);
  return blId;
}

function settleWith(blId: number, amount: number, kind: "BANK" | "OFFSET" = "BANK") {
  const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: kind === "BANK" ? "RECEIPT" : "INVOICE" }, NOW);
  const refund = createRefund(
    db,
    acc,
    { agencyId: line, customerId: testCustomer(db), amountMinor: usd(amount), currency: "USD", valueDate: "2026-10-21", kind, evidenceDocumentId: evidence.id, confirmDuplicate: true },
    NOW,
  );
  if (refund.status !== "created") throw new Error("refund");
  confirmAllocation(db, ops, { refundId: refund.id, lines: [{ blId, amountMinor: usd(amount) }], shortfall: null, remainderReason: null }, NOW);
}

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
});

describe("accounting entry before a B/L counts as collected", () => {
  it("is not needed for a full bank refund without deductions", () => {
    const bl = requestedBl("HAT0000001", 1000);
    settleWith(bl, 1000);
    expect(status(bl)).toBe("COLLECTED");
  });

  it("is needed after an offset refund, and after statement deductions that take the deposit", () => {
    const offset = requestedBl("HAT0000002", 1000);
    settleWith(offset, 1000, "OFFSET");
    expect(status(offset)).toBe("ACCOUNTING_PENDING");

    const statement = requestedBl("HAT0000003", 1000);
    const demurrage = listDeductionTypes(db, ops).find((t) => t.code === null)!.id;
    const document = storeUpload(db, ops, { originalName: "ekstre.pdf", content: PDF, kind: "DEDUCTION_STATEMENT" }, NOW).id;
    recordStatementDeductions(db, ops, { blId: statement, documentId: document, lines: [{ deductionTypeId: demurrage, amountMinor: usd(1000) }] }, NOW);
    expect(status(statement)).toBe("ACCOUNTING_PENDING");
  });

  it("is recorded by an accountant only; the B/L is then collected, audited, and the accountant may undo it", () => {
    const bl = requestedBl("HAT0000004", 1000);
    settleWith(bl, 1000, "OFFSET");
    expect(() => recordAccountingEntry(db, ops, { blIds: [bl] }, NOW)).toThrow(ForbiddenError);
    const [auditId] = recordAccountingEntry(db, acc, { blIds: [bl] }, NOW);
    expect(status(bl)).toBe("COLLECTED");
    expect(db.select().from(auditLog).where(eq(auditLog.id, auditId)).get()).toMatchObject({
      action: "bl.accountingRecorded",
      roleUsed: "ACCOUNTANT",
      before: { status: "ACCOUNTING_PENDING" },
      after: { status: "COLLECTED" },
    });
    expect(() => recordAccountingEntry(db, acc, { blIds: [bl] }, NOW)).toThrow(/bls.errors.notAwaitingAccounting/);
    undoActions(db, acc, { auditIds: [auditId] }, later(5));
    expect(status(bl)).toBe("ACCOUNTING_PENDING");
  });

  it("is refused for a B/L that does not wait for it", () => {
    const bl = requestedBl("HAT0000005", 1000);
    expect(() => recordAccountingEntry(db, acc, { blIds: [bl] }, NOW)).toThrow(/bls.errors.notAwaitingAccounting/);
  });

  it("leaves a waiting B/L settled: nothing outstanding, no refund matching, no additional deposit", () => {
    const bl = requestedBl("HAT0000006", 1000);
    settleWith(bl, 1000, "OFFSET");
    expect(positions(db, ops, NOW).find((p) => p.id === bl)).toMatchObject({ open: false, outstandingMinor: 0, daysWaiting: null });

    const evidence = storeUpload(db, acc, { originalName: "iade2.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const extra = createRefund(
      db,
      acc,
      { agencyId: line, customerId: testCustomer(db), amountMinor: usd(10), currency: "USD", valueDate: "2026-10-21", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true },
      NOW,
    );
    if (extra.status !== "created") throw new Error("refund");
    expect(allocationProposal(db, ops, extra.id).candidates.map((c) => c.blId)).not.toContain(bl);

    expect(() =>
      createPayment(
        db,
        acc,
        { agencyId: line, amountMinor: usd(100), currency: "USD", paidAt: "2026-10-20", kind: "BANK", blNoHint: "HAT0000006", evidenceDocumentId: null, queueItemId: null, confirmDuplicate: true },
        NOW,
      ),
    ).toThrow(/payments.errors.additionalClosed/);
  });
});
