import { beforeEach, describe, expect, it } from "vitest";
import { agencyInputSchema, type AgencyOverrides } from "@/lib/schemas/agencies";
import { createAgency, updateAgencyOverrides } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail, listAllBls, searchBls } from "@/server/bl-overview";
import { createBls, voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { addLedgerEntry } from "@/server/ledger";
import { correctPayment, createPayment } from "@/server/payments";
import { createTestDb, makeUser } from "../support/db";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
const NO_OVERRIDES: AgencyOverrides = {
  "durations.firstRequestDueDays": null,
  "durations.upcomingDays": null,
  "durations.followUpDays": null,
  "durations.statementRequestDays": null,
  "durations.statementFollowUpDays": null,
};
const PDF = Buffer.from("%PDF-1.4\n% test receipt\n");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;
let maersk: number;

const agency = (name: string) =>
  createAgency(
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
    }),
  );

function bl(input: { agencyId: number; blNo: string; amountMinor: number; paidAt: string; currency?: string; containers?: string[] }) {
  const result = createPayment(
    db,
    acc,
    {
      agencyId: input.agencyId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "USD",
      paidAt: input.paidAt,
      kind: "BANK",
      blNoHint: null,
      evidenceDocumentId: storeUpload(db, acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, NOW).id,
      queueItemId: null,
      confirmDuplicate: true,
    },
    NOW,
  );
  if (result.status !== "created") throw new Error("payment not created");
  const created = createBls(db, ops, [{ paymentId: result.id, blNo: input.blNo, containers: input.containers ?? [] }], NOW).created[0];
  return { paymentId: result.id, blId: created.blId };
}

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = agency("MSC Şahin");
  maersk = agency("Maersk");
});

describe("listAllBls", () => {
  it("derives balances from the ledger and shows DUE from the current settings", () => {
    const a = bl({ agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-10-01" });
    bl({ agencyId: maersk, blNo: "MAEU2000002", amountMinor: 150000, paidAt: "2026-10-20", currency: "EUR" });
    addLedgerEntry(db, { blId: a.blId, type: "DEDUCTION", amountMinor: 70000, currency: "USD", entryDate: "2026-10-21", createdBy: ops.id });

    const rows = listAllBls(db, acc, NOW);
    expect(rows.map((r) => r.blNo)).toEqual(["MAEU2000002", "MEDU1000001"]);
    expect(rows[1]).toMatchObject({ status: "DUE", depositMinor: 300000, deductionsMinor: 70000, expectedMinor: 230000, daysWaiting: 15 });
    // Paid on Tuesday, due 7 business days later: still PAID on Thursday.
    expect(rows[0]).toMatchObject({ status: "PAID", currency: "EUR", expectedMinor: 150000, daysWaiting: 2 });

    // An agency override applies to its B/Ls only.
    updateAgencyOverrides(db, admin, { agencyId: maersk, overrides: { ...NO_OVERRIDES, "durations.firstRequestDueDays": 1 }, reason: null }, NOW);
    expect(listAllBls(db, acc, NOW).map((r) => r.status)).toEqual(["DUE", "DUE"]);
  });

  it("keeps voided B/Ls readable but stops their waiting time", () => {
    const a = bl({ agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-10-01" });
    voidBl(db, ops, { id: a.blId, reason: "Yanlış kayıt" }, NOW);
    expect(listAllBls(db, ops, NOW)[0]).toMatchObject({ voidReason: "Yanlış kayıt", daysWaiting: null });
  });

  it("is open to every role, but not to deactivated users", () => {
    expect(() => listAllBls(db, { ...acc, active: false }, NOW)).toThrow(ForbiddenError);
    expect(() => listAllBls(db, admin, NOW)).not.toThrow();
  });
});

describe("searchBls", () => {
  beforeEach(() => {
    bl({ agencyId: msc, blNo: "MEDU1000001", amountMinor: 300050, paidAt: "2026-10-01", containers: ["MSCU1234565"] });
    bl({ agencyId: maersk, blNo: "MAEU2000002", amountMinor: 150000, paidAt: "2026-10-02", containers: ["CSQU3054383"] });
  });

  it("finds B/Ls by number, container, agency and amount", () => {
    expect(searchBls(db, ops, "medu1", NOW).items.map((i) => i.blNo)).toEqual(["MEDU1000001"]);
    expect(searchBls(db, ops, "CSQU3054", NOW).items[0]).toMatchObject({ blNo: "MAEU2000002", matched: ["container"] });
    expect(searchBls(db, ops, "sahin", NOW).items.map((i) => i.blNo)).toEqual(["MEDU1000001"]);
    expect(searchBls(db, ops, "3.000,50", NOW).items.map((i) => i.blNo)).toEqual(["MEDU1000001"]);
    expect(searchBls(db, ops, "  ", NOW).items).toEqual([]);
  });

  it("lists every match of a pasted list and reports the numbers it did not find", () => {
    const result = searchBls(db, ops, "MEDU1000001\nCSQU3054383\nZZZU0000000", NOW);
    expect(result.items.map((i) => i.blNo).sort()).toEqual(["MAEU2000002", "MEDU1000001"]);
    expect(result.notFound).toEqual(["ZZZU0000000"]);
  });

  it("leaves voided B/Ls out", () => {
    const found = searchBls(db, ops, "MEDU1000001", NOW).items[0];
    voidBl(db, ops, { id: found.id, reason: "Yanlış kayıt" }, NOW);
    expect(searchBls(db, ops, "MEDU1000001", NOW).items).toEqual([]);
  });
});

describe("getBlDetail", () => {
  it("returns the source payment, ledger and a timeline of payment, upload and B/L events", () => {
    const a = bl({ agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-10-01" });
    correctPayment(db, acc, { id: a.paymentId, agencyId: msc, amountMinor: 310000, currency: "USD", paidAt: "2026-10-01", reason: "Tutar hatalı" }, NOW);

    const detail = getBlDetail(db, ops, a.blId, NOW);
    expect(detail.bl).toMatchObject({ blNo: "MEDU1000001", depositMinor: 310000 });
    expect(detail.payment).toMatchObject({ id: a.paymentId, kind: "BANK", evidenceName: "dekont.pdf", createdByName: "ACC" });
    expect(detail.ledger.map((l) => [l.amountMinor, l.compensated])).toEqual([
      [300000, true],
      [-300000, false],
      [310000, false],
    ]);
    expect(detail.timeline.map((e) => e.action)).toEqual([
      "document.upload",
      "payment.create",
      "bl.create",
      "payment.correct",
      "bl.followPaymentCorrection",
    ]);
    expect(detail.timeline[3]).toMatchObject({ actorName: "ACC", reason: "Tutar hatalı" });
    expect(() => getBlDetail(db, ops, 9999, NOW)).toThrow(expect.objectContaining({ messageKey: "errors.notFound" }));
  });
});
