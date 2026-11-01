import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agencyDetailsMissing } from "@/domain/agency";
import { agencyInputSchema } from "@/lib/schemas/agencies";
import { createPaymentSchema } from "@/lib/schemas/payments";
import { createAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { listAllBls } from "@/server/bl-overview";
import { createBls, updateBl, voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { agencies, auditLog, billsOfLading, documents, ledgerEntries } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { documentPath, storeUpload } from "@/server/files";
import { ledgerDeposit } from "@/server/ledger";
import { listNotifications } from "@/server/notifications";
import {
  correctPayment,
  createPayment,
  discardQueueItem,
  enqueueReceipt,
  listOwnPayments,
  listPaymentsAwaitingBl,
  listReceiptQueue,
  voidPayment,
} from "@/server/payments";
import { updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { confirmedAllocationFixture } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");
const PDF = Buffer.from("%PDF-1.4\n% test receipt\n");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let acc2: AuthUser;
let ops: AuthUser;
let agencyId: number;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  acc2 = await makeUser(db, "acc2", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  agencyId = createAgency(
    db,
    ops,
    agencyInputSchema.parse({
      name: "MSC",
      active: true,
      toRecipients: [],
      ccRecipients: [],
      bankSenderAliases: [],
      blNumberPatterns: [String.raw`MEDU\d{7}`],
      batchSending: false,
      requestChannel: "EMAIL",
      portalUrl: "",
      notes: "",
    }),
  );
});

const upload = (user: AuthUser, kind: "RECEIPT" | "INVOICE" = "RECEIPT", name = "dekont.pdf") =>
  storeUpload(db, user, { originalName: name, content: PDF, kind }, NOW);

const pay = (overrides: Record<string, unknown> = {}, user = acc) =>
  createPayment(
    db,
    user,
    {
      agencyId,
      amountMinor: 300000,
      currency: "USD",
      paidAt: "2026-10-20",
      kind: "BANK",
      blNoHint: null,
      evidenceDocumentId: (overrides.evidenceDocumentId as number | undefined) ?? upload(user).id,
      queueItemId: null,
      confirmDuplicate: false,
      ...overrides,
    },
    NOW,
  );

const created = (result: ReturnType<typeof pay>) => {
  if (result.status !== "created") throw new Error("expected created");
  return result.id;
};

describe("files", () => {
  it("stores allowed files in the data folder and rejects wrong types, sizes and contents", () => {
    const doc = upload(acc, "RECEIPT", "../../etc/dekont.pdf");
    expect(doc.originalName).toBe("dekont.pdf");
    expect(fs.readFileSync(documentPath(doc))).toEqual(PDF);

    expect(() => storeUpload(db, acc, { originalName: "x.exe", content: PDF, kind: "RECEIPT" })).toThrow(
      expect.objectContaining({ messageKey: "files.errors.type" }),
    );
    expect(() => storeUpload(db, acc, { originalName: "x.pdf", content: Buffer.from("not a pdf"), kind: "RECEIPT" })).toThrow(
      expect.objectContaining({ messageKey: "files.errors.content" }),
    );
    updateSettings(db, admin, { changes: [{ key: "rules.maxFileSizeMb", value: 1 }] });
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
    expect(() => storeUpload(db, acc, { originalName: "x.pdf", content: big, kind: "RECEIPT" })).toThrow(
      expect.objectContaining({ messageKey: "files.errors.size" }),
    );
  });
});

describe("deposit payments", () => {
  it("is created by an accountant with the uploaded receipt attached", () => {
    const id = created(pay());
    const [row] = listOwnPayments(db, acc);
    expect(row).toMatchObject({ id, amountMinor: 300000, blId: null });
    expect(row).not.toHaveProperty("bankAccountId");
    expect(db.select().from(documents).where(eq(documents.id, row.evidenceDocumentId!)).get()).toMatchObject({
      ownerType: "deposit_payment",
      ownerId: id,
    });
    expect(() => pay({}, ops)).toThrow(ForbiddenError);
  });

  it("requires matching evidence: a receipt for bank payments, an invoice for offsets", () => {
    expect(() => pay({ evidenceDocumentId: upload(acc, "INVOICE").id })).toThrow(
      expect.objectContaining({ messageKey: "files.errors.evidence" }),
    );
    // Someone else's upload cannot be claimed.
    expect(() => pay({ evidenceDocumentId: upload(acc2).id })).toThrow(expect.objectContaining({ messageKey: "files.errors.evidence" }));
    // An offset needs an invoice.
    expect(created(pay({ kind: "OFFSET", evidenceDocumentId: upload(acc, "INVOICE").id }))).toBeGreaterThan(0);
  });

  it("rejects future dates and inactive currencies", () => {
    expect(() => pay({ currency: "GBP" })).toThrow(expect.objectContaining({ messageKey: "payments.errors.currency" }));
    expect(() => pay({ paidAt: "2026-10-23" })).toThrow(expect.objectContaining({ messageKey: "payments.errors.futureDate" }));
  });

  it("warns about a duplicate and saves it only after confirmation", () => {
    created(pay());
    const second = pay();
    expect(second.status).toBe("duplicate");
    expect(second.status === "duplicate" && second.duplicates[0]).toMatchObject({ agencyName: "MSC", amountMinor: 300000 });
    expect(created(pay({ confirmDuplicate: true }))).toBeGreaterThan(0);

    updateSettings(db, admin, { changes: [{ key: "rules.duplicateWarning", value: false }] });
    expect(pay().status).toBe("created");
  });
});

describe("payment for an agency not in the system", () => {
  const byName = (name: string) => db.select().from(agencies).where(eq(agencies.name, name)).get();

  it("adds the agency by name, audits it under the accountant role and notifies operations", async () => {
    const ops2 = await makeUser(db, "ops2", ["OPERATIONS"]);
    const result = pay({ agencyId: null, newAgencyName: "  Yeni Hat Lojistik " });
    if (result.status !== "created") throw new Error("expected created");
    const agency = byName("Yeni Hat Lojistik")!;
    expect(agency).toMatchObject({ active: true, toRecipients: [], blNumberPatterns: [], requestChannel: "EMAIL" });
    expect(agencyDetailsMissing(agency)).toBe(true);
    expect(result.agencyId).toBe(agency.id);
    expect(listOwnPayments(db, acc).find((p) => p.id === result.id)).toMatchObject({ agencyId: agency.id });

    const audit = db.select().from(auditLog).where(and(eq(auditLog.action, "agency.create"), eq(auditLog.entityId, String(agency.id)))).get();
    expect(audit).toMatchObject({ actorUserId: acc.id, roleUsed: "ACCOUNTANT" });
    for (const user of [ops, ops2]) {
      expect(listNotifications(db, user)).toMatchObject([
        { kind: "NEW_AGENCY", entityType: "agency", entityId: agency.id, detail: { agency: "Yeni Hat Lojistik" } },
      ]);
    }
    expect(listNotifications(db, acc)).toEqual([]);
  });

  it("uses an existing agency of the same name instead of adding another", () => {
    const result = pay({ agencyId: null, newAgencyName: "msc" });
    expect(result.status === "created" && result.agencyId).toBe(agencyId);
    expect(db.select().from(agencies).all()).toHaveLength(1);
    expect(listNotifications(db, ops)).toEqual([]);
  });

  it("adds no agency when the payment is rejected", () => {
    expect(() => pay({ agencyId: null, newAgencyName: "Yeni Hat", paidAt: "2026-10-23" })).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.futureDate" }),
    );
    expect(byName("Yeni Hat")).toBeUndefined();
  });

  it("needs exactly one of an agency or a new agency name", () => {
    const base = { amountMinor: 100, currency: "USD", paidAt: "2026-10-20", kind: "BANK", blNoHint: "" };
    expect(createPaymentSchema.safeParse({ ...base, agencyId: agencyId }).success).toBe(true);
    expect(createPaymentSchema.safeParse({ ...base, agencyId: null, newAgencyName: "Yeni" }).success).toBe(true);
    expect(createPaymentSchema.safeParse({ ...base, agencyId: null, newAgencyName: "  " }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ ...base, agencyId: agencyId, newAgencyName: "Yeni" }).success).toBe(false);
  });
});

describe("B/L creation", () => {
  it("saves valid rows together and returns the invalid ones with their errors", () => {
    const p1 = created(pay({ paidAt: "2026-10-01" }));
    const p2 = created(pay({ paidAt: "2026-10-02" }));
    const p3 = created(pay({ paidAt: "2026-10-03" }));
    const p4 = created(pay({ paidAt: "2026-10-04" }));

    const result = createBls(
      db,
      ops,
      [
        { paymentId: p1, blNo: " medu1234567 ", containers: ["csqu 305438-3"] },
        { paymentId: p2, blNo: "MEDU1234567", containers: [] }, // same number twice in the batch
        { paymentId: p3, blNo: "MEDU7654321", containers: ["BAD1"] },
        { paymentId: p4, blNo: "X", containers: [] },
      ],
      NOW,
    );
    expect(result.created).toEqual([{ index: 0, paymentId: p1, blId: expect.any(Number), blNo: "MEDU1234567" }]);
    expect(result.errors).toEqual([
      { index: 1, field: "blNo", message: "bls.errors.blNoDuplicateInBatch" },
      { index: 2, field: "containers", message: "bls.errors.containerFormat", item: 1 },
      { index: 3, field: "blNo", message: "bls.errors.blNo" },
    ]);

    const bl = listAllBls(db, ops, NOW)[0];
    expect(bl).toMatchObject({ blNo: "MEDU1234567", status: "DUE", containers: ["CSQU3054383"], depositMinor: 300000 });
    expect(ledgerDeposit(db, bl.id)).toBe(300000);
    expect(listPaymentsAwaitingBl(db, ops).map((p) => p.id)).toEqual([p2, p3, p4]);
    expect(() => createBls(db, acc, [{ paymentId: p2, blNo: "MEDU0000001", containers: [] }])).toThrow(ForbiddenError);
  });

  it("allows one active B/L per payment; voiding frees the payment and the number", () => {
    const p1 = created(pay());
    expect(createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]).created).toHaveLength(1);
    expect(createBls(db, ops, [{ paymentId: p1, blNo: "MEDU9999999", containers: [] }]).errors[0].message).toBe(
      "bls.errors.paymentUnavailable",
    );
    const [bl] = listAllBls(db, ops, NOW);
    voidBl(db, ops, { id: bl.id, reason: "Yanlış B/L numarası" });
    expect(listPaymentsAwaitingBl(db, ops).map((p) => p.id)).toEqual([p1]);
    expect(createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]).created).toHaveLength(1);
  });

  it("edits number and containers while no request has been sent", () => {
    const p1 = created(pay());
    createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]);
    const [bl] = listAllBls(db, ops, NOW);
    updateBl(db, ops, { id: bl.id, blNo: "MEDU1234568", containers: ["CSQU3054383"] });
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ blNo: "MEDU1234568", containers: ["CSQU3054383"] });
    db.update(billsOfLading).set({ status: "REQUESTED" }).where(eq(billsOfLading.id, bl.id)).run();
    expect(() => updateBl(db, ops, { id: bl.id, blNo: "MEDU1234569", containers: [] })).toThrow(
      expect.objectContaining({ messageKey: "bls.errors.blNoLocked" }),
    );
  });
});

describe("corrections and voiding", () => {
  it("lets only the creating accountant correct, with a reason; the B/L and ledger follow", () => {
    const p1 = created(pay());
    createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]);
    const [bl] = listAllBls(db, ops, NOW);
    const correction = { id: p1, agencyId, amountMinor: 250000, currency: "USD", paidAt: "2026-10-19", reason: "Dekont tutarı hatalı girildi" };

    expect(() => correctPayment(db, acc2, correction)).toThrow(ForbiddenError);
    expect(() => correctPayment(db, ops, correction)).toThrow(ForbiddenError);
    correctPayment(db, acc, correction, NOW);

    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ depositMinor: 250000, paidAt: "2026-10-19" });
    expect(ledgerDeposit(db, bl.id)).toBe(250000);
    const entries = db.select().from(ledgerEntries).where(eq(ledgerEntries.blId, bl.id)).all();
    expect(entries.map((e) => e.amountMinor)).toEqual([300000, -300000, 250000]);
    expect(entries[1].compensatesEntryId).toBe(entries[0].id);
    const audit = db.select().from(auditLog).where(eq(auditLog.action, "payment.correct")).get();
    expect(audit).toMatchObject({ roleUsed: "ACCOUNTANT", reason: "Dekont tutarı hatalı girildi" });
  });

  it("moves the whole B/L to the new currency on a currency correction", () => {
    const p1 = created(pay());
    createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]);
    const [bl] = listAllBls(db, ops, NOW);
    correctPayment(db, acc, { id: p1, agencyId, amountMinor: 280000, currency: "EUR", paidAt: "2026-10-20", reason: "Para birimi EUR" }, NOW);
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ currency: "EUR", depositMinor: 280000 });
    expect(ledgerDeposit(db, bl.id)).toBe(280000);
  });

  it("voids a payment only after its B/L is voided, and freezes records with a confirmed allocation", () => {
    const p1 = created(pay());
    createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]);
    const [bl] = listAllBls(db, ops, NOW);
    expect(() => voidPayment(db, acc, { id: p1, reason: "Mükerrer" })).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.voidBlFirst" }),
    );

    // A confirmed refund allocation freezes both records (rules 13 and 15).
    confirmedAllocationFixture(db, { acc, ops }, { blId: bl.id, agencyId, amountMinor: 300000, now: NOW });
    expect(() => voidBl(db, ops, { id: bl.id, reason: "x" })).toThrow(expect.objectContaining({ messageKey: "bls.errors.allocated" }));
    expect(() =>
      correctPayment(db, acc, { id: p1, agencyId, amountMinor: 1, currency: "USD", paidAt: "2026-10-20", reason: "x" }),
    ).toThrow(expect.objectContaining({ messageKey: "payments.errors.allocated" }));
  });

  it("voids after the B/L is voided; voided payments leave the work lists", () => {
    const p1 = created(pay());
    createBls(db, ops, [{ paymentId: p1, blNo: "MEDU1234567", containers: [] }]);
    voidBl(db, ops, { id: listAllBls(db, ops, NOW)[0].id, reason: "Yanlış kayıt" });
    voidPayment(db, acc, { id: p1, reason: "Mükerrer kayıt" });
    expect(listPaymentsAwaitingBl(db, ops)).toEqual([]);
    expect(listOwnPayments(db, acc)[0]).toMatchObject({ voidReason: "Mükerrer kayıt" });
    expect(db.select().from(auditLog).where(and(eq(auditLog.action, "payment.void"), eq(auditLog.entityId, String(p1)))).get()).toBeTruthy();
  });
});

describe("receipt review queue", () => {
  it("queues bulk receipts per accountant; saving or discarding resolves them", () => {
    const d1 = upload(acc);
    const d2 = upload(acc);
    const q1 = enqueueReceipt(db, acc, d1, { parser: "stub" });
    const q2 = enqueueReceipt(db, acc, d2, { parser: "stub" });
    expect(listReceiptQueue(db, acc).map((q) => q.id)).toEqual([q1, q2]);
    expect(listReceiptQueue(db, acc2)).toEqual([]);

    created(pay({ evidenceDocumentId: d1.id, queueItemId: q1 }));
    expect(() => discardQueueItem(db, acc2, { id: q2 })).toThrow(expect.objectContaining({ messageKey: "payments.errors.queueItem" }));
    discardQueueItem(db, acc, { id: q2 });
    expect(listReceiptQueue(db, acc)).toEqual([]);
  });
});
