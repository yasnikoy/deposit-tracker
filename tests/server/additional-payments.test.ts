import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { billsOfLading, documents } from "@/server/db/schema";
import { prepareRequestEmails } from "@/server/email/compose";
import { DomainError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { correctPayment, createPayment, lacksPaymentEvidence, listPaymentsAwaitingBl, voidPayment } from "@/server/payments";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let one: number;
let other: number;
let first: { paymentId: number; blId: number };

function pay(input: { amount: number; blNo: string | null; agencyId?: number; currency?: string; paidAt?: string; receipt?: boolean }) {
  const evidence = input.receipt === false ? null : storeUpload(db, acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, NOW).id;
  const result = createPayment(
    db,
    acc,
    {
      agencyId: input.agencyId ?? one,
      amountMinor: input.amount * 100,
      currency: input.currency ?? "USD",
      paidAt: input.paidAt ?? "2026-09-08",
      kind: "BANK",
      blNoHint: input.blNo,
      evidenceDocumentId: evidence,
      queueItemId: null,
      confirmDuplicate: true,
    },
    NOW,
  );
  if (result.status !== "created") throw new Error("not created");
  return result;
}

const bl = () => db.select().from(billsOfLading).where(eq(billsOfLading.id, first.blId)).get()!;
const deposit = () => getBlDetail(db, ops, first.blId, NOW).bl.depositMinor;

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  one = makeAgency(db, ops, "Ocean Network", { toRecipients: ["iade@one.example"] });
  other = makeAgency(db, ops, "Hapag", { toRecipients: ["iade@hapag.example"] });
  // The first transfer: 500 USD on 8 Sep, its B/L created by operations.
  first = makeBl(db, { acc, ops }, { agencyId: one, blNo: "ONEYTESTP0000500", amountMinor: 50000, paidAt: "2026-09-08" }, NOW);
});

describe("additional deposit payments", () => {
  it("a payment entered with an existing B/L number joins it: one combined deposit, both receipts", () => {
    const second = pay({ amount: 4500, blNo: "oneytestp0000500" });
    expect(second.additionalTo).toEqual({ blId: first.blId, blNo: "ONEYTESTP0000500" });
    expect(deposit()).toBe(500000);
    expect(bl()).toMatchObject({ depositAmountMinor: 500000, paidAt: "2026-09-08", depositPaymentId: first.paymentId });
    // It is not waiting for a B/L of its own.
    expect(listPaymentsAwaitingBl(db, ops)).toEqual([]);

    const detail = getBlDetail(db, ops, first.blId, NOW);
    expect(detail.payment).toMatchObject({ id: first.paymentId, amountMinor: 50000 });
    expect(detail.additionalPayments).toMatchObject([{ id: second.id, amountMinor: 450000, evidenceName: "Dekont ONEYTESTP0000500 (2).pdf" }]);
    expect(detail.timeline.map((e) => e.action)).toContain("bl.additionalPayment");

    // Requests attach the form and both receipts.
    uploadBlForm(db, ops, { blId: first.blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [first.blId] }, NOW);
    expect(draft.attachments.map((a) => a.originalName)).toEqual(
      expect.arrayContaining(["Dekont ONEYTESTP0000500.pdf", "Dekont ONEYTESTP0000500 (2).pdf"]),
    );
  });

  it("must match the B/L's agency and currency, and the B/L must still be open; an unknown number stays a hint", () => {
    expect(() => pay({ amount: 100, blNo: "ONEYTESTP0000500", agencyId: other })).toThrow(/additionalMismatch/);
    expect(() => pay({ amount: 100, blNo: "ONEYTESTP0000500", currency: "EUR" })).toThrow(/additionalMismatch/);
    expect(pay({ amount: 100, blNo: "ONEYNEW0000001" }).additionalTo).toBeNull();
    db.update(billsOfLading).set({ status: "COLLECTED" }).where(eq(billsOfLading.id, first.blId)).run();
    expect(() => pay({ amount: 100, blNo: "ONEYTESTP0000500" })).toThrow(/additionalClosed/);
  });

  it("corrections touch only the corrected payment; agency or currency cannot change while the B/L has several", () => {
    const second = pay({ amount: 4500, blNo: "ONEYTESTP0000500" });
    correctPayment(db, acc, { id: second.id, agencyId: one, amountMinor: 400000, currency: "USD", paidAt: "2026-09-08", reason: "Tutar hatalı" }, NOW);
    expect(deposit()).toBe(450000);
    correctPayment(db, acc, { id: first.paymentId, agencyId: one, amountMinor: 60000, currency: "USD", paidAt: "2026-09-07", reason: "Tarih" }, NOW);
    expect(deposit()).toBe(460000);
    expect(bl()).toMatchObject({ depositAmountMinor: 460000, paidAt: "2026-09-07" });
    expect(() =>
      correctPayment(db, acc, { id: first.paymentId, agencyId: other, amountMinor: 60000, currency: "USD", paidAt: "2026-09-07", reason: "Acente" }, NOW),
    ).toThrow(/additionalMismatch/);
  });

  it("an additional deposit can be voided on its own; the first payment still goes only with its B/L", () => {
    const second = pay({ amount: 4500, blNo: "ONEYTESTP0000500" });
    expect(() => voidPayment(db, acc, { id: first.paymentId, reason: "Yanlış" }, NOW)).toThrow(DomainError);
    voidPayment(db, acc, { id: second.id, reason: "Mükerrer" }, NOW);
    expect(deposit()).toBe(50000);
    expect(getBlDetail(db, ops, first.blId, NOW).additionalPayments).toEqual([]);
    expect(getBlDetail(db, ops, first.blId, NOW).timeline.map((e) => e.action)).toContain("bl.additionalPaymentVoided");
  });

  it("a B/L warns about a missing receipt when any of its payments lacks one", () => {
    expect(lacksPaymentEvidence(db, bl())).toBe(false);
    pay({ amount: 4500, blNo: "ONEYTESTP0000500", receipt: false });
    expect(lacksPaymentEvidence(db, bl())).toBe(true);
  });

  it("voiding the B/L returns both payments to the work list", () => {
    pay({ amount: 4500, blNo: "ONEYTESTP0000500" });
    voidBl(db, ops, { id: first.blId, reason: "Yanlış kayıt" }, NOW);
    expect(listPaymentsAwaitingBl(db, ops).map((p) => p.amountMinor).sort()).toEqual([450000, 50000].sort());
    expect(db.select().from(documents).all().length).toBeGreaterThan(0);
  });
});
