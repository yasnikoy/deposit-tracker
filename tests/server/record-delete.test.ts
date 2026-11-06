import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteAgency, listAgencies } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { createCustomer, deleteCustomer, listCustomers } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { auditLog, notifications } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { createPayment } from "@/server/payments";
import { queueReportEmail } from "@/server/report-email";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
});

const auditOf = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).all();

describe("deleting an agency", () => {
  it("is possible for an admin while no record names it; its notifications go, the audit keeps the card", () => {
    // Added by name from a payment that was then rejected: no record, but operations was notified.
    const test = makeAgency(db, ops, "Deneme Acente", { notes: "deneme" });
    db.insert(notifications)
      .values({ userId: ops.id, kind: "NEW_AGENCY", entityType: "agency", entityId: test, detail: {}, createdAt: NOW.toISOString() })
      .run();

    expect(() => deleteAgency(db, ops, { id: test, reason: "deneme" }, NOW)).toThrow(ForbiddenError);
    deleteAgency(db, admin, { id: test, reason: "Deneme kaydı" }, NOW);
    expect(listAgencies(db, admin)).toEqual([]);
    expect(db.select().from(notifications).all()).toEqual([]);
    expect(auditOf("agency.delete")).toMatchObject([{ roleUsed: "ADMIN", entityId: String(test), reason: "Deneme kaydı", before: { name: "Deneme Acente", notes: "deneme" } }]);
    // The name is free again.
    makeAgency(db, ops, "Deneme Acente");
  });

  it("is refused while a payment, B/L or report email names it, listing what does", () => {
    const msc = makeAgency(db, ops, "MSC");
    makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 100000, paidAt: "2026-10-01" }, NOW);
    expect(() => deleteAgency(db, admin, { id: msc, reason: "x" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "agencies.errors.inUse", params: { links: "1 B/L, 1 ödeme" } }),
    );

    // A payment alone (its B/L not created yet) names it too.
    const other = makeAgency(db, ops, "Hat");
    createPayment(db, acc, { agencyId: other, amountMinor: 100, currency: "USD", paidAt: "2026-10-01", kind: "BANK", blNoHint: null, evidenceDocumentId: null, queueItemId: null, confirmDuplicate: true }, NOW);
    expect(() => deleteAgency(db, admin, { id: other, reason: "x" }, NOW)).toThrow(expect.objectContaining({ params: { links: "1 ödeme" } }));

    // A sent report filtered by the agency keeps its filter readable.
    const filtered = makeAgency(db, ops, "Filtre Acente");
    updateSettings(
      db,
      admin,
      { changes: [{ key: "email.fromAddress", value: "depozito@firmagrup.com" }, { key: "reports.internalDomains", value: ["firma.com.tr"] }] },
      NOW,
    );
    queueReportEmail(
      db,
      ops,
      { sections: ["REMAINING"], filters: { agencyIds: [filtered], currency: null, requestedFrom: null, requestedTo: null, collectedFrom: null, collectedTo: null }, to: ["mudur@firma.com.tr"], cc: [], subject: "Rapor", body: "Merhaba", attachSections: [] },
      NOW,
    );
    expect(() => deleteAgency(db, admin, { id: filtered, reason: "x" }, NOW)).toThrow(expect.objectContaining({ params: { links: "1 rapor e-postası filtresi" } }));
    expect(listAgencies(db, admin)).toHaveLength(3);
    expect(auditOf("agency.delete")).toEqual([]);
  });
});

describe("deleting a customer", () => {
  it("is possible for an admin while no B/L or refund names it", () => {
    const test = createCustomer(db, admin, { name: "Deneme Müşteri", code: null, aliases: [] }, NOW);
    expect(() => deleteCustomer(db, ops, { id: test, reason: "x" }, NOW)).toThrow(ForbiddenError);
    deleteCustomer(db, admin, { id: test, reason: "Deneme kaydı" }, NOW);
    expect(listCustomers(db, admin)).toEqual([]);
    expect(auditOf("customer.delete")).toMatchObject([{ roleUsed: "ADMIN", reason: "Deneme kaydı", before: { name: "Deneme Müşteri" } }]);
  });

  it("is refused while a B/L names it", () => {
    const msc = makeAgency(db, ops, "MSC");
    const customer = createCustomer(db, admin, { name: "Örnek İthalat", code: null, aliases: [] }, NOW);
    makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 100000, paidAt: "2026-10-01", customerId: customer }, NOW);
    expect(() => deleteCustomer(db, admin, { id: customer, reason: "x" }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "customers.errors.inUse", params: { links: "1 B/L" } }),
    );
  });
});
