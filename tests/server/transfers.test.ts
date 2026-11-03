import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail, listAllBls } from "@/server/bl-overview";
import { recordAccountingEntry, voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { billsOfLading } from "@/server/db/schema";
import { prepareRequestEmails } from "@/server/email/compose";
import { ForbiddenError } from "@/server/errors";
import { correctPayment } from "@/server/payments";
import { reportEmailDraft } from "@/server/report-email";
import { positions } from "@/server/reports";
import { listDueRequests } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { previewTransfer, reverseTransfer, transferDeposit, transfersInPeriod, type TransferInput } from "@/server/transfers";
import { createTestDb, makeUser } from "../support/db";
import { giveStandingDocuments, makeAgency, makeBl, markRequested, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;
let source: { paymentId: number; blId: number };

const input = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  sourceBlId: source.blId,
  targetBlNo: "MEDU2000001",
  transferredOn: "2026-10-20",
  customerId: testCustomer(db),
  fileNo: "26-20001",
  unitId: null,
  note: "Acente depozitoyu yeni sevkiyata saydı",
  ...overrides,
});
const status = (blId: number) => db.select({ s: billsOfLading.status }).from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.s;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  giveStandingDocuments(db, ops);
  updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "depozito@firma.com.tr" }, { key: "rules.blockSendingWithoutForm", value: false }] }, NOW);
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
  source = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-09-01" }, NOW);
  markRequested(db, ops, { blId: source.blId, requestedOn: "2026-09-15" }, NOW);
});

describe("transferring a B/L's deposit to a new B/L", () => {
  it("settles the source for the accounting entry and starts a new B/L from the transfer date", () => {
    expect(previewTransfer(db, ops, { sourceBlId: source.blId, targetBlNo: "MEDU2000001" })).toEqual({ amountMinor: 300000, currency: "USD", existing: null });
    const { targetBlId, created } = transferDeposit(db, ops, input(), NOW);
    expect(created).toBe(true);

    const from = getBlDetail(db, ops, source.blId, NOW);
    expect(from.bl).toMatchObject({ status: "ACCOUNTING_PENDING", depositMinor: 300000, expectedMinor: 0 });
    expect(from.bl.description).toBe("20.10.2026: 3.000,00 USD depozito B/L MEDU2000001 kaydına aktarıldı.");
    const to = getBlDetail(db, ops, targetBlId, NOW);
    expect(to.bl).toMatchObject({ blNo: "MEDU2000001", status: "PAID", paidAt: "2026-10-20", depositMinor: 300000, expectedMinor: 300000, fileNo: "26-20001", attempts: 0 });
    expect(to.bl.description).toBe("20.10.2026: B/L MEDU1000001 için ödenen 3.000,00 USD depozito bu B/L'ye aktarıldı.");
    expect(to.timeline[0]).toMatchObject({ action: "bl.createFromTransfer", reason: "Acente depozitoyu yeni sevkiyata saydı" });

    // Only the new B/L is open: no money is counted twice.
    const open = positions(db, ops, NOW).filter((p) => p.open);
    expect(open.map((p) => [p.blNo, p.outstandingMinor])).toEqual([["MEDU2000001", 300000]]);
    expect(transfersInPeriod(db, "2026-10-01", "2026-10-31")).toEqual([expect.objectContaining({ sourceBlNo: "MEDU1000001", targetBlNo: "MEDU2000001", amountMinor: 300000 })]);

    // The accountant books it: TRANSFERRED, never collected.
    recordAccountingEntry(db, acc, { blIds: [source.blId] }, NOW);
    expect(status(source.blId)).toBe("TRANSFERRED");
  });

  it("sends the new B/L's first request with the source's receipt, as a brand-new B/L", () => {
    const { targetBlId } = transferDeposit(db, acc, input(), NOW);
    // Due after the first-request delay from the transfer date, not from the original payment.
    expect(listDueRequests(db, ops, NOW).DUE.flatMap((g) => g.rows).some((r) => r.blId === targetBlId)).toBe(false);
    const later = new Date("2026-11-20T09:00:00Z");
    const row = listDueRequests(db, ops, later).DUE.flatMap((g) => g.rows).find((r) => r.blId === targetBlId);
    expect(row).toMatchObject({ kind: "FIRST", attemptNo: 1, evidenceMissing: false });
    const [draft] = prepareRequestEmails(db, ops, { blIds: [targetBlId] }, later);
    expect(draft.attachments.filter((a) => a.kind === "RECEIPT").map((a) => a.originalName)).toEqual(["Dekont MEDU1000001.pdf"]);
  });

  it("joins an open B/L of the same agency and currency instead, which keeps its own details", () => {
    const other = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU3000001", amountMinor: 100000, paidAt: "2026-10-01" }, NOW);
    expect(previewTransfer(db, ops, { sourceBlId: source.blId, targetBlNo: "medu3000001" }).existing).toEqual({ blId: other.blId, blNo: "MEDU3000001", depositMinor: 100000 });
    expect(() => transferDeposit(db, ops, input({ targetBlNo: "MEDU3000001" }), NOW)).toThrow(expect.objectContaining({ messageKey: "transfers.errors.joinFields" }));
    transferDeposit(db, ops, input({ targetBlNo: "MEDU3000001", customerId: null, fileNo: null }), NOW);
    expect(getBlDetail(db, ops, other.blId, NOW).bl).toMatchObject({ depositMinor: 400000, expectedMinor: 400000 });
    expect(status(other.blId)).toBe("PAID");
    const hapag = makeAgency(db, ops, "Hapag");
    makeBl(db, { acc, ops }, { agencyId: hapag, blNo: "HLCU1000001", amountMinor: 100000, paidAt: "2026-10-01" }, NOW);
    const second = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000009", amountMinor: 50000, paidAt: "2026-09-01" }, NOW);
    expect(() => transferDeposit(db, ops, input({ sourceBlId: second.blId, targetBlNo: "HLCU1000001", customerId: null, fileNo: null }), NOW)).toThrow(
      expect.objectContaining({ messageKey: "payments.errors.additionalMismatch" }),
    );
  });

  it("is refused for the wrong people, settled B/Ls, the same B/L and future dates", () => {
    expect(() => transferDeposit(db, admin, input(), NOW)).toThrow(ForbiddenError);
    expect(() => transferDeposit(db, ops, input({ targetBlNo: "MEDU1000001" }), NOW)).toThrow(expect.objectContaining({ messageKey: "transfers.errors.same" }));
    expect(() => transferDeposit(db, ops, input({ transferredOn: "2026-10-23" }), NOW)).toThrow(expect.objectContaining({ messageKey: "payments.errors.futureDate" }));
    transferDeposit(db, ops, input(), NOW);
    expect(() => transferDeposit(db, ops, input({ targetBlNo: "MEDU2000002" }), NOW)).toThrow(expect.objectContaining({ messageKey: "transfers.errors.notOpen" }));
  });

  it("freezes both B/Ls' money records: no voiding, no payment correction", () => {
    const { targetBlId } = transferDeposit(db, ops, input(), NOW);
    expect(() => voidBl(db, ops, { id: targetBlId, reason: "Yanlış" }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.transferred" }));
    expect(() => voidBl(db, ops, { id: source.blId, reason: "Yanlış" }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.transferred" }));
    expect(() =>
      correctPayment(db, acc, { id: source.paymentId, agencyId: msc, amountMinor: 310000, currency: "USD", paidAt: "2026-09-01", reason: "Tutar" }, NOW),
    ).toThrow(expect.objectContaining({ messageKey: "payments.errors.transferred" }));
  });
});

describe("reversing a transfer (admin)", () => {
  it("restores the source and voids the B/L the transfer created", () => {
    const { targetBlId } = transferDeposit(db, ops, input(), NOW);
    expect(() => reverseTransfer(db, ops, { sourceBlId: source.blId, reason: "Yanlış B/L" }, NOW)).toThrow(ForbiddenError);
    reverseTransfer(db, admin, { sourceBlId: source.blId, reason: "Yanlış B/L" }, NOW);
    expect(getBlDetail(db, ops, source.blId, NOW).bl).toMatchObject({ status: "REQUESTED", expectedMinor: 300000 });
    expect(listAllBls(db, ops, NOW).find((b) => b.id === targetBlId)).toMatchObject({ voidReason: "Yanlış B/L" });
    expect(transfersInPeriod(db, "2026-10-01", "2026-10-31")).toEqual([]);
    // The number is free again for a correct transfer.
    transferDeposit(db, ops, input(), NOW);
  });

  it("is refused once accounting booked it", () => {
    transferDeposit(db, ops, input(), NOW);
    recordAccountingEntry(db, acc, { blIds: [source.blId] }, NOW);
    expect(() => reverseTransfer(db, admin, { sourceBlId: source.blId, reason: "Geç" }, NOW)).toThrow(expect.objectContaining({ messageKey: "transfers.errors.booked" }));
  });
});

describe("the report email", () => {
  it("lists the deposits transferred in its period, source to target", () => {
    transferDeposit(db, ops, input(), NOW);
    const filters = { agencyIds: [], currency: null, requestedFrom: null, requestedTo: null, collectedFrom: null, collectedTo: null };
    const draft = reportEmailDraft(db, ops, { sections: ["TRANSFERRED"], filters: { ...filters, transferredFrom: "2026-10-20", transferredTo: "2026-10-22" } }, NOW);
    expect(draft.summary).toBe("Aktarılan depozitolar (20.10.2026 – 22.10.2026)\n• MSC: B/L MEDU1000001 → B/L MEDU2000001, 3.000,00 USD (20.10.2026)");
    expect(draft.attachments).toEqual([{ fileName: "Aktarılan depozitolar 2026-10-22.csv", rows: 1 }]);
    expect(() => reportEmailDraft(db, ops, { sections: ["TRANSFERRED"], filters }, NOW)).toThrow(/period/);
  });
});
