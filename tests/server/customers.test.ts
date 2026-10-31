import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { createBls } from "@/server/bls";
import { createCustomer, listCustomers } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { billsOfLading } from "@/server/db/schema";
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
  ornek = createCustomer(db, acc, { name: "Ornek Enerji A.Ş.", code: "1001", aliases: ["ORNEK"] }, NOW);
});

describe("customers", () => {
  it("are registered by accounting or operations, with unique names and codes", () => {
    expect(() => createCustomer(db, ops, { name: "ornek enerji a.ş.", code: null, aliases: [] }, NOW)).toThrow(/nameTaken/);
    expect(() => createCustomer(db, ops, { name: "Başka", code: "1001", aliases: [] }, NOW)).toThrow(/codeTaken/);
    expect(() => createCustomer(db, admin, { name: "Beta", code: null, aliases: [] }, NOW)).toThrow(ForbiddenError);
    createCustomer(db, ops, { name: "Beta İnşaat", code: "1002", aliases: ["BETA"] }, NOW);
    expect(listCustomers(db, admin).map((c) => c.name)).toEqual(["Beta İnşaat", "Ornek Enerji A.Ş."]);
  });
});

describe("customer and file number on a new B/L", () => {
  it("come from the payment's receipt when not given", () => {
    const paymentId = payment("MEDUTST10007 - ORNEK ENERJİ A.Ş.DEPO T26-90815", "T26-90815");
    const { created } = createBls(db, ops, [{ paymentId, blNo: "MEDUTST10007", containers: [] }], NOW);
    expect(blOf(created[0].blId)).toMatchObject({ customerId: ornek, fileNo: "T26-90815" });
  });

  it("as given take precedence; null leaves them empty", () => {
    const beta = createCustomer(db, ops, { name: "Beta İnşaat", code: null, aliases: ["BETA"] }, NOW);
    const p1 = payment("MEDUTST10007 - ORNEK ENERJİ A.Ş.DEPO T26-90815", "T26-90815");
    const p2 = payment("MEDUTST10008 ORNEK DEPO T26-90816", "T26-90816");
    const { created } = createBls(
      db,
      ops,
      [
        { paymentId: p1, blNo: "MEDUTST10007", containers: [], customerId: beta, fileNo: "t26-99999" },
        { paymentId: p2, blNo: "MEDUTST10008", containers: [], customerId: null, fileNo: null },
      ],
      NOW,
    );
    expect(blOf(created[0].blId)).toMatchObject({ customerId: beta, fileNo: "T26-99999" });
    expect(blOf(created[1].blId)).toMatchObject({ customerId: null, fileNo: null });
  });

  it("no customer is filled in when the description fits none, or several", () => {
    createCustomer(db, ops, { name: "Ornek Lojistik", code: null, aliases: ["ORNEK"] }, NOW);
    const paymentId = payment("MEDUTST10007 - ORNEK DEPO");
    const { created } = createBls(db, ops, [{ paymentId, blNo: "MEDUTST10007", containers: [] }], NOW);
    expect(blOf(created[0].blId)).toMatchObject({ customerId: null, fileNo: null });
  });
});
