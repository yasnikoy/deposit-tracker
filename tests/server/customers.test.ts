import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { createBls, setBlCustomer } from "@/server/bls";
import { createCustomer, listCustomers, suggestCustomer, updateCustomer } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { auditLog, billsOfLading } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { createPayment } from "@/server/payments";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, PDF } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;
let ornek: number;

function payment(description: string, fileNumber?: string): number {
  const result = createPayment(
    db,
    acc,
    {
      agencyId: msc,
      amountMinor: 200000,
      currency: "USD",
      paidAt: "2026-10-19",
      kind: "BANK",
      blNoHint: null,
      evidenceDocumentId: storeUpload(db, acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, NOW).id,
      queueItemId: null,
      confirmDuplicate: true,
      extraction: { parser: "garanti", description, fileNumber },
    },
    NOW,
  );
  if (result.status !== "created") throw new Error("payment");
  return result.id;
}

const blOf = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = makeAgency(db, ops, "MSC");
  ornek = createCustomer(db, admin, { name: "Ornek Enerji A.Ş.", code: "1001", aliases: ["ORNEK"] }, NOW);
});

describe("customers", () => {
  it("are registered by an admin only, with unique names and codes", () => {
    expect(() => createCustomer(db, admin, { name: "ornek enerji a.ş.", code: null, aliases: [] }, NOW)).toThrow(/nameTaken/);
    expect(() => createCustomer(db, admin, { name: "Başka", code: "1001", aliases: [] }, NOW)).toThrow(/codeTaken/);
    expect(() => createCustomer(db, ops, { name: "Beta", code: null, aliases: [] }, NOW)).toThrow(ForbiddenError);
    expect(() => createCustomer(db, acc, { name: "Beta", code: null, aliases: [] }, NOW)).toThrow(ForbiddenError);
    createCustomer(db, admin, { name: "Beta İnşaat", code: "1002", aliases: ["BETA"] }, NOW);
    expect(listCustomers(db, admin).map((c) => c.name)).toEqual(["Beta İnşaat", "Ornek Enerji A.Ş."]);
  });
});

describe("customer and file number on a new B/L", () => {
  it("come from the payment's receipt when not given", () => {
    const paymentId = payment("MEDUTST10007 - ORNEK ENERJİ A.Ş.DEPO T26-90815", "T26-90815");
    const { created } = createBls(db, ops, [{ paymentId, blNo: "MEDUTST10007" }], NOW);
    expect(blOf(created[0].blId)).toMatchObject({ customerId: ornek, fileNo: "26-90815" });
  });

  it("as given take precedence; null leaves them empty", () => {
    const beta = createCustomer(db, admin, { name: "Beta İnşaat", code: null, aliases: ["BETA"] }, NOW);
    const p1 = payment("MEDUTST10007 - ORNEK ENERJİ A.Ş.DEPO T26-90815", "T26-90815");
    const p2 = payment("MEDUTST10008 ORNEK DEPO T26-90816", "T26-90816");
    const { created } = createBls(
      db,
      ops,
      [
        { paymentId: p1, blNo: "MEDUTST10007", customerId: beta, fileNo: "t26-99999" },
        { paymentId: p2, blNo: "MEDUTST10008", customerId: null, fileNo: null },
      ],
      NOW,
    );
    expect(blOf(created[0].blId)).toMatchObject({ customerId: beta, fileNo: "26-99999" });
    expect(blOf(created[1].blId)).toMatchObject({ customerId: null, fileNo: null });
  });

  it("no customer is filled in when the description fits none, or several", () => {
    createCustomer(db, admin, { name: "Ornek Lojistik", code: null, aliases: ["ORNEK"] }, NOW);
    const paymentId = payment("MEDUTST10007 - ORNEK DEPO");
    const { created } = createBls(db, ops, [{ paymentId, blNo: "MEDUTST10007" }], NOW);
    expect(blOf(created[0].blId)).toMatchObject({ customerId: null, fileNo: null });
  });
});

describe("customer cards", () => {
  const card = (overrides: Partial<{ name: string; code: string | null; aliases: string[]; active: boolean }> = {}) => ({
    name: "Ornek Enerji A.Ş.",
    code: "1001",
    aliases: ["ORNEK"],
    active: true,
    ...overrides,
  });

  it("are edited by an admin: aliases make receipts name the customer, audited", () => {
    expect(() => updateCustomer(db, ops, { id: ornek, customer: card({ aliases: ["ORN"] }) }, NOW)).toThrow(ForbiddenError);
    expect(suggestCustomer(db, "ODEME ORNEKSA T26-1")).toBeNull();
    updateCustomer(db, admin, { id: ornek, customer: card({ aliases: ["ORNEK", "ORNEKSA", "ORNEKSA"] }) }, NOW);
    expect(listCustomers(db, acc)[0].aliases).toEqual(["ORNEK", "ORNEKSA"]);
    expect(suggestCustomer(db, "ODEME ORNEKSA T26-1")).toBe(ornek);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "customer.update")).get()).toMatchObject({ roleUsed: "ADMIN" });
    expect(() => updateCustomer(db, admin, { id: ornek, customer: card({ aliases: ["ORNEK", "ORNEKSA"] }) }, NOW)).toThrow(/noChanges/);
  });

  it("keep names and codes unique, and a deactivated customer is no longer suggested", () => {
    const beta = createCustomer(db, admin, { name: "Beta", code: "2002", aliases: ["BETA"] }, NOW);
    expect(() => updateCustomer(db, admin, { id: beta, customer: card({ name: "ornek enerji a.ş.", code: "2002", aliases: [] }) }, NOW)).toThrow(/nameTaken/);
    expect(() => updateCustomer(db, admin, { id: beta, customer: card({ name: "Beta", code: "1001", aliases: [] }) }, NOW)).toThrow(/codeTaken/);
    updateCustomer(db, admin, { id: beta, customer: card({ name: "Beta", code: "2002", aliases: ["BETA"], active: false }) }, NOW);
    expect(suggestCustomer(db, "BETA DEPOZITO")).toBeNull();
  });
});


describe("customer on the B/L detail", () => {
  it("is set or cleared by accounting, operations or an admin, audited; only active customers are newly assigned", () => {
    const { created } = createBls(db, ops, [{ paymentId: payment("MEDUTST10099 DEPO"), blNo: "MEDUTST10099", customerId: null }], NOW);
    const blId = created[0].blId;
    setBlCustomer(db, acc, { blId, customerId: ornek }, NOW);
    expect(blOf(blId).customerId).toBe(ornek);
    expect(() => setBlCustomer(db, ops, { blId, customerId: ornek }, NOW)).toThrow(/noChanges/);
    const beta = createCustomer(db, admin, { name: "Beta", code: null, aliases: [] }, NOW);
    updateCustomer(db, admin, { id: beta, customer: { name: "Beta", code: null, aliases: [], active: false } }, NOW);
    expect(() => setBlCustomer(db, ops, { blId, customerId: beta }, NOW)).toThrow(/customers.errors.unknown/);
    setBlCustomer(db, admin, { blId, customerId: null }, NOW);
    expect(blOf(blId).customerId).toBeNull();
    const audits = db.select().from(auditLog).where(eq(auditLog.action, "bl.setCustomer")).all();
    expect(audits.map((a) => [a.roleUsed, a.before, a.after])).toEqual([
      ["ACCOUNTANT", { customerId: null }, { customerId: ornek }],
      ["ADMIN", { customerId: ornek }, { customerId: null }],
    ]);
  });
});
