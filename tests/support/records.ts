import { eq } from "drizzle-orm";
import { nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { agencyInputSchema, type AgencyInput, type AgencyOverrides } from "@/lib/schemas/agencies";
import { createAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { createBls, setBlUnit, updateBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { billsOfLading, customers, refundAllocations, refunds, requests } from "@/server/db/schema";
import { storeUpload } from "@/server/files";
import { addLedgerEntry } from "@/server/ledger";
import { createPayment } from "@/server/payments";
import { setStandingDocument } from "@/server/standing-documents";

export const PDF = Buffer.from("%PDF-1.4\n% test receipt\n");

export const NO_OVERRIDES: AgencyOverrides = {
  "durations.firstRequestDueDays": null,
  "durations.upcomingDays": null,
  "durations.followUpDays": null,
  "durations.statementRequestDays": null,
  "durations.statementFollowUpDays": null,
};

export function makeAgency(db: Db, ops: AuthUser, name: string, overrides: Partial<AgencyInput> = {}): number {
  return createAgency(
    db,
    ops,
    agencyInputSchema.parse({
      name,
      active: true,
      toRecipients: [],
      ccRecipients: [],
      bankSenderAliases: [],
      blNumberPatterns: [],
      batchSending: false,
      requestChannel: "EMAIL",
      portalUrl: "",
      notes: "",
      ...overrides,
    }),
  );
}

/** A bank payment (by the accountant) and its B/L (by operations). */
/** The customer test B/Ls and refunds belong to unless a test says otherwise (refunds need one). */
export function testCustomer(db: Db): number {
  const existing = db.select().from(customers).where(eq(customers.name, "Test Müşteri")).get();
  if (existing) return existing.id;
  const at = new Date().toISOString();
  return db.insert(customers).values({ name: "Test Müşteri", createdAt: at, updatedAt: at }).returning().get().id;
}

export function makeBl(
  db: Db,
  users: { acc: AuthUser; ops: AuthUser },
  input: { agencyId: number; blNo: string; amountMinor: number; paidAt: string; currency?: string; containers?: string[]; customerId?: number | null; unitId?: number | null },
  now: Date,
): { paymentId: number; blId: number } {
  const result = createPayment(
    db,
    users.acc,
    {
      agencyId: input.agencyId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "USD",
      paidAt: input.paidAt,
      kind: "BANK",
      blNoHint: null,
      evidenceDocumentId: storeUpload(db, users.acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, now).id,
      queueItemId: null,
      confirmDuplicate: true,
    },
    now,
  );
  if (result.status !== "created") throw new Error("payment not created");
  const customerId = input.customerId === undefined ? testCustomer(db) : input.customerId;
  const created = createBls(db, users.ops, [{ paymentId: result.id, blNo: input.blNo, customerId }], now).created[0];
  if (!created) throw new Error("B/L not created");
  // The unit is chosen after creation, as on Talepler or the B/L detail.
  if (input.unitId) setBlUnit(db, users.ops, { blIds: [created.blId], unitId: input.unitId }, now);
  // Containers are entered on the B/L detail, after creation.
  if (input.containers?.length) updateBl(db, users.ops, { id: created.blId, containers: input.containers }, now);
  return { paymentId: result.id, blId: created.blId };
}

/**
 * A confirmed refund allocation written straight to the tables, for tests about what an
 * allocation freezes; the allocation flow itself is tested in allocations.test.ts.
 */
export function confirmedAllocationFixture(
  db: Db,
  users: { acc: AuthUser; ops: AuthUser },
  input: { blId: number; agencyId: number; amountMinor: number; currency?: string; now: Date },
): number {
  const at = input.now.toISOString();
  const currency = input.currency ?? "USD";
  const evidence = storeUpload(db, users.acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, input.now);
  const refund = db
    .insert(refunds)
    .values({ agencyId: input.agencyId, customerId: testCustomer(db), amountMinor: input.amountMinor, currency, valueDate: at.slice(0, 10), kind: "BANK", evidenceDocumentId: evidence.id, createdBy: users.acc.id, createdAt: at, updatedAt: at })
    .returning()
    .get();
  const allocation = db
    .insert(refundAllocations)
    .values({ refundId: refund.id, blId: input.blId, amountMinor: input.amountMinor, blStatusBefore: "REQUESTED", confirmedBy: users.ops.id, roleUsed: "OPERATIONS", confirmedAt: at })
    .returning()
    .get();
  addLedgerEntry(db, { blId: input.blId, type: "REFUND_ALLOCATION", amountMinor: input.amountMinor, currency, entryDate: at.slice(0, 10), refundAllocationId: allocation.id, createdBy: users.ops.id }, input.now);
  return allocation.id;
}

/**
 * Puts a B/L into REQUESTED as if its first refund request had gone out on `requestedOn`: a
 * shortcut for tests that start later in the request chain.
 */
export function markRequested(db: Db, user: AuthUser, input: { blId: number; requestedOn: string }, now: Date): void {
  db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get()!;
    const at = now.toISOString();
    tx.insert(requests)
      .values({ blId: bl.id, type: "REFUND", channel: "EMAIL", attemptNo: 1, sendStatus: "SENT", requestedOn: input.requestedOn, sentAt: at, createdBy: user.id, createdAt: at })
      .run();
    tx.update(billsOfLading)
      .set({ status: nextStatus(bl.status as StoredBlStatus, "REFUND_REQUEST_SENT"), updatedAt: at })
      .where(eq(billsOfLading.id, bl.id))
      .run();
  });
}

/**
 * Gives a customer (the test customer by default) its signature circular and power of
 * attorney, which every request email of its B/Ls attaches.
 */
export function giveStandingDocuments(db: Db, user: AuthUser, customerId: number = testCustomer(db), now: Date = new Date("2026-01-01T09:00:00Z")): void {
  for (const slot of ["SIGNATURE_CIRCULAR", "POWER_OF_ATTORNEY"] as const) {
    const documentId = storeUpload(db, user, { originalName: `${slot.toLowerCase()}.pdf`, content: PDF, kind: "STANDING" }, now).id;
    setStandingDocument(db, user, { customerId, slot, documentId }, now);
  }
}
