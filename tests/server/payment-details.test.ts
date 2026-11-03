import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openingBalanceSchema } from "@/lib/schemas/opening-balances";
import { createPaymentSchema } from "@/lib/schemas/payments";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { createBls } from "@/server/bls";
import { createCustomer } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { auditLog, customers } from "@/server/db/schema";
import { listNotifications } from "@/server/notifications";
import { createOpeningBalance } from "@/server/opening-balances";
import { correctPayment, createPayment, listPayments, type NewPayment } from "@/server/payments";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;
let delta: number;

const pay = (overrides: Partial<NewPayment> = {}) => {
  const result = createPayment(
    db,
    acc,
    { agencyId: msc, amountMinor: 300000, currency: "USD", paidAt: "2026-10-01", kind: "BANK", blNoHint: null, evidenceDocumentId: null, queueItemId: null, confirmDuplicate: true, ...overrides },
    NOW,
  );
  if (result.status !== "created") throw new Error("payment not created");
  return result;
};
const blOf = (paymentId: number, blNo: string) => createBls(db, ops, [{ paymentId, blNo }], NOW).created[0].blId;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = makeAgency(db, ops, "MSC");
  delta = createCustomer(db, admin, { name: "Delta", code: null, aliases: [] }, NOW);
});

describe("a payment's customer, file number and description", () => {
  it("are stored with the payment and taken over by its B/L once", () => {
    // As the form sends it: the input schema drops the "T" of transfer descriptions.
    expect(createPaymentSchema.parse({ agencyId: msc, amountMinor: 1, currency: "USD", paidAt: "2026-10-01", kind: "BANK", blNoHint: "", fileNo: "T26-12345" }).fileNo).toBe("26-12345");
    const { id } = pay({ customerId: delta, fileNo: "26-12345", description: "Ek depozito istendi" });
    expect(listPayments(db, acc).find((p) => p.id === id)).toMatchObject({ customerName: "Delta", fileNo: "26-12345", description: "Ek depozito istendi" });
    const blId = blOf(id, "MEDU1000001");
    expect(getBlDetail(db, ops, blId, NOW).bl).toMatchObject({ customerId: delta, fileNo: "26-12345", description: "Ek depozito istendi" });
  });

  it("let the accountant name a new customer; admins are told to complete its card", () => {
    const { id } = pay({ newCustomerName: " Yeni İthalat " });
    const added = db.select().from(customers).where(eq(customers.name, "Yeni İthalat")).get()!;
    expect(listPayments(db, acc).find((p) => p.id === id)?.customerId).toBe(added.id);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "customer.create")).all().at(-1)).toMatchObject({ roleUsed: "ACCOUNTANT", entityId: String(added.id) });
    expect(listNotifications(db, admin)).toEqual([expect.objectContaining({ kind: "NEW_CUSTOMER", entityType: "customer", entityId: added.id })]);
    expect(listNotifications(db, ops)).toEqual([]);
    // The same name again is the same customer, without a second notification.
    pay({ newCustomerName: "yeni ithalat", amountMinor: 1000 });
    expect(db.select().from(customers).all()).toHaveLength(2);
    expect(listNotifications(db, admin)).toHaveLength(1);
  });

  it("stay with the B/L when the payment joins it; its description goes with the deposit", () => {
    const blId = blOf(pay({ customerId: delta, fileNo: "26-00001" }).id, "MEDU1000001");
    expect(() => pay({ blNoHint: "MEDU1000001", customerId: delta, amountMinor: 50000 })).toThrow(expect.objectContaining({ messageKey: "payments.errors.joinFields" }));
    pay({ blNoHint: "MEDU1000001", amountMinor: 50000, description: "Ek depozito, liman cezası için" });
    const detail = getBlDetail(db, ops, blId, NOW);
    expect(detail.bl).toMatchObject({ customerId: delta, fileNo: "26-00001", description: null });
    expect(detail.additionalPayments).toEqual([expect.objectContaining({ amountMinor: 50000, description: "Ek depozito, liman cezası için" })]);
    expect(detail.timeline.find((e) => e.action === "bl.additionalPayment")).toMatchObject({ reason: "Ek depozito, liman cezası için" });
  });

  it("are corrected on the payment only while it has no B/L", () => {
    const { id } = pay();
    const base = { id, agencyId: msc, amountMinor: 300000, currency: "USD", paidAt: "2026-10-01", reason: "Müşteri eksikti" };
    correctPayment(db, acc, { ...base, customerId: delta, fileNo: "26-55555" }, NOW);
    expect(listPayments(db, acc)[0]).toMatchObject({ customerId: delta, fileNo: "26-55555" });
    blOf(id, "MEDU1000001");
    expect(() => correctPayment(db, acc, { ...base, customerId: null }, NOW)).toThrow(expect.objectContaining({ messageKey: "payments.errors.customerOnBl" }));
    // Money corrections go on as before.
    correctPayment(db, acc, { ...base, amountMinor: 310000 }, NOW);
  });

  it("on the opening balance: its description starts the new B/L's description", () => {
    const result = createOpeningBalance(
      db,
      admin,
      openingBalanceSchema.parse({ agencyId: msc, kind: "BANK", amountMinor: 250000, currency: "USD", paidAt: "2026-07-01", blNo: "MEDU9000001", documentId: null, pastAttempts: 0, lastRequestOn: null, note: "Excel satır 14", confirmDuplicate: true }),
      NOW,
    );
    expect(result.status === "created" && getBlDetail(db, ops, result.blId, NOW).bl.description).toBe("Excel satır 14");
  });
});
