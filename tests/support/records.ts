import { eq } from "drizzle-orm";
import { agencyInputSchema, type AgencyInput, type AgencyOverrides } from "@/lib/schemas/agencies";
import { createAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { createBls } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { customers, refundAllocations, refunds } from "@/server/db/schema";
import { storeUpload } from "@/server/files";
import { addLedgerEntry } from "@/server/ledger";
import { createPayment } from "@/server/payments";

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
  input: { agencyId: number; blNo: string; amountMinor: number; paidAt: string; currency?: string; containers?: string[]; customerId?: number | null },
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
  const created = createBls(db, users.ops, [{ paymentId: result.id, blNo: input.blNo, containers: input.containers ?? [], customerId }], now).created[0];
  if (!created) throw new Error("B/L not created");
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
