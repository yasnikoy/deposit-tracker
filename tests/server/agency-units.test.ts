import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agencyCard, agencyInputSchema, type AgencyInput } from "@/lib/schemas/agencies";
import { activeUnitOptions, listAgencies, unitsByAgency, updateAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail, listAllBls } from "@/server/bl-overview";
import { createBls, setBlUnit } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { auditLog, billsOfLading } from "@/server/db/schema";
import { prepareRequestEmails } from "@/server/email/compose";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { createOpeningBalance } from "@/server/opening-balances";
import { createPayment } from "@/server/payments";
import { listDueRequests } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { undoActions } from "@/server/undo";
import { openingBalanceSchema } from "@/lib/schemas/opening-balances";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF, giveStandingDocuments } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let culines: number;
let msc: number;

const card = (agencyId: number): AgencyInput => {
  const agency = listAgencies(db, ops).find((a) => a.id === agencyId)!;
  return agencyInputSchema.parse({ ...agency, portalUrl: agency.portalUrl ?? "", notes: agency.notes ?? "" });
};
const unitIds = (agencyId: number) => Object.fromEntries((unitsByAgency(db, [agencyId]).get(agencyId) ?? []).map((u) => [u.name, u.id]));
const payment = (agencyId: number) =>
  (() => {
    const result = createPayment(
      db,
      acc,
      {
        agencyId,
        amountMinor: 300000,
        currency: "USD",
        paidAt: "2026-10-01",
        kind: "BANK",
        blNoHint: null,
        evidenceDocumentId: storeUpload(db, acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, NOW).id,
        queueItemId: null,
        confirmDuplicate: true,
      },
      NOW,
    );
    if (result.status !== "created") throw new Error("payment not created");
    return result.id;
  })();

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  giveStandingDocuments(db, ops);
  updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "depozito@firma.com.tr" }, { key: "rules.blockSendingWithoutForm", value: false }] }, NOW);
  culines = makeAgency(db, ops, "CULines", {
    toRecipients: ["genel@culines.example"],
    batchSending: true,
    units: [
      { id: null, name: "Mersin", active: true, toRecipients: ["mersin@culines.example"], ccRecipients: ["cc.mersin@culines.example"] },
      { id: null, name: "İzmir", active: true, toRecipients: ["izmir@culines.example"], ccRecipients: [] },
    ],
  });
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
});

describe("agency units on the card", () => {
  it("are saved with the card, audited with it and undone with it", () => {
    expect(listAgencies(db, ops).find((a) => a.id === culines)!.units.map((u) => u.name)).toEqual(["Mersin", "İzmir"]);
    const [auditId] = updateAgency(db, ops, { id: culines, agency: { ...card(culines), units: [...card(culines).units, { id: null, name: "Gemlik", active: true, toRecipients: ["gemlik@culines.example"], ccRecipients: [] }] } }, NOW);
    expect(Object.keys(unitIds(culines))).toEqual(["Mersin", "İzmir", "Gemlik"]);
    const audit = db.select().from(auditLog).where(eq(auditLog.id, auditId)).get()!;
    expect((audit.after as { units: { name: string }[] }).units.map((u) => u.name)).toEqual(["Mersin", "İzmir", "Gemlik"]);
    undoActions(db, ops, { auditIds: [auditId] }, NOW);
    expect(Object.keys(unitIds(culines))).toEqual(["Mersin", "İzmir"]);
  });

  it("refuse duplicate names; a unit a B/L names is deactivated, never removed", () => {
    expect(agencyInputSchema.safeParse({ ...card(culines), units: [...card(culines).units, { id: null, name: "mersin", active: true, toRecipients: [], ccRecipients: [] }] }).success).toBe(false);
    makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000001", amountMinor: 300000, paidAt: "2026-10-01", unitId: unitIds(culines).Mersin }, NOW);
    const withoutMersin = { ...card(culines), units: card(culines).units.filter((u) => u.name !== "Mersin") };
    expect(() => updateAgency(db, ops, { id: culines, agency: withoutMersin }, NOW)).toThrow(expect.objectContaining({ messageKey: "agencies.errors.unitInUse" }));
    updateAgency(db, ops, { id: culines, agency: { ...card(culines), units: card(culines).units.map((u) => (u.name === "Mersin" ? { ...u, active: false } : u)) } }, NOW);
    expect(activeUnitOptions(db)[culines].map((u) => u.name)).toEqual(["İzmir"]);
    // An unused unit can be taken off the card.
    updateAgency(db, ops, { id: culines, agency: { ...card(culines), units: card(culines).units.filter((u) => u.name !== "İzmir") } }, NOW);
    expect(Object.keys(unitIds(culines))).toEqual(["Mersin"]);
  });

  it("travel with the agency export without their ids", () => {
    expect(agencyCard(card(culines)).units).toEqual([
      { id: null, name: "Mersin", active: true, toRecipients: ["mersin@culines.example"], ccRecipients: ["cc.mersin@culines.example"] },
      { id: null, name: "İzmir", active: true, toRecipients: ["izmir@culines.example"], ccRecipients: [] },
    ]);
  });
});

describe("B/Ls of an agency with units", () => {
  it("are created without a unit; it is chosen before sending", () => {
    const [p1, p2] = [payment(culines), payment(msc)];
    // A unit sent from an older client is ignored: creation never takes one.
    const { created, errors } = createBls(db, ops, [{ paymentId: p1, blNo: "CULU1000001", unitId: unitIds(culines).İzmir }, { paymentId: p2, blNo: "MEDU1000001" }], NOW);
    expect(errors).toEqual([]);
    expect(created.map((c) => c.blNo)).toEqual(["CULU1000001", "MEDU1000001"]);
    expect(listAllBls(db, ops, NOW).map((b) => b.unitId)).toEqual([null, null]);
  });

  it("can only name a unit of their own agency, even written straight to the database", () => {
    const { blId } = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-10-01" }, NOW);
    expect(() => db.update(billsOfLading).set({ unitId: unitIds(culines).Mersin }).where(eq(billsOfLading.id, blId)).run()).toThrow(/FOREIGN KEY/);
  });

  it("change unit on the B/L detail (operations, audited)", () => {
    const { blId } = makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000001", amountMinor: 300000, paidAt: "2026-10-01", unitId: unitIds(culines).Mersin }, NOW);
    expect(() => setBlUnit(db, acc, { blIds: [blId], unitId: unitIds(culines).İzmir }, NOW)).toThrow(ForbiddenError);
    expect(() => setBlUnit(db, ops, { blIds: [blId], unitId: 9999 }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.unitUnknown" }));
    setBlUnit(db, ops, { blIds: [blId], unitId: unitIds(culines).İzmir }, NOW);
    const detail = getBlDetail(db, ops, blId, NOW);
    expect(detail.bl).toMatchObject({ unitName: "İzmir" });
    expect(detail.timeline[0]).toMatchObject({ action: "bl.setUnit" });
  });

  it("get a unit in bulk: all the selected B/Ls, or none when one cannot take it", () => {
    const bl = (blNo: string, agencyId = culines) => makeBl(db, { acc, ops }, { agencyId, blNo, amountMinor: 300000, paidAt: "2026-10-01" }, NOW).blId;
    const [a, b, other] = [bl("CULU1000001"), bl("CULU1000002"), bl("MEDU1000001", msc)];
    const unitOf = () => listAllBls(db, ops, NOW).map((x) => [x.blNo, x.unitName]);
    expect(() => setBlUnit(db, ops, { blIds: [a, other], unitId: unitIds(culines).Mersin }, NOW)).toThrow(expect.objectContaining({ messageKey: "bls.errors.unitUnknown", params: { bl: "MEDU1000001" } }));
    expect(unitOf().every(([, unit]) => unit === null)).toBe(true);
    setBlUnit(db, ops, { blIds: [a, b], unitId: unitIds(culines).Mersin }, NOW);
    expect(unitOf()).toEqual(expect.arrayContaining([["CULU1000001", "Mersin"], ["CULU1000002", "Mersin"]]));
    // B/Ls already on the unit are left as they are; nothing to change is refused.
    setBlUnit(db, ops, { blIds: [a, b], unitId: unitIds(culines).İzmir }, NOW);
    expect(() => setBlUnit(db, ops, { blIds: [a, b], unitId: unitIds(culines).İzmir }, NOW)).toThrow(expect.objectContaining({ messageKey: "settings.noChanges" }));
  });

  it("take no unit in the opening-balance form either", () => {
    const input = openingBalanceSchema.parse({ agencyId: culines, kind: "BANK", amountMinor: 250000, currency: "USD", paidAt: "2026-07-01", blNo: "CULU9000001", documentId: null, pastAttempts: 0, lastRequestOn: null, note: "", confirmDuplicate: true });
    const result = createOpeningBalance(db, admin, input, NOW);
    expect(result.status === "created" && getBlDetail(db, ops, result.blId, NOW).bl.unitId).toBeNull();
  });
});

describe("requests of an agency with units", () => {
  it("go to the unit's recipients, one batch email per unit", () => {
    const { Mersin, İzmir } = unitIds(culines);
    const m1 = makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000001", amountMinor: 300000, paidAt: "2026-10-01", unitId: Mersin }, NOW).blId;
    const m2 = makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000002", amountMinor: 300000, paidAt: "2026-10-01", unitId: Mersin }, NOW).blId;
    const i1 = makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000003", amountMinor: 300000, paidAt: "2026-10-01", unitId: İzmir }, NOW).blId;
    const drafts = prepareRequestEmails(db, ops, { blIds: [m1, m2, i1] }, NOW);
    expect(drafts.map((d) => ({ to: d.to, cc: d.cc, bls: d.items.map((i) => i.blNo) }))).toEqual([
      { to: ["mersin@culines.example"], cc: ["cc.mersin@culines.example"], bls: ["CULU1000001", "CULU1000002"] },
      { to: ["izmir@culines.example"], cc: [], bls: ["CULU1000003"] },
    ]);
  });

  it("are refused for a B/L without a unit, which the due list marks", () => {
    // B/Ls are created without a unit.
    const { blId } = makeBl(db, { acc, ops }, { agencyId: culines, blNo: "CULU1000001", amountMinor: 300000, paidAt: "2026-10-01" }, NOW);
    expect(listDueRequests(db, ops, NOW).DUE[0].rows[0]).toMatchObject({ blNo: "CULU1000001", unitMissing: true });
    expect(() => prepareRequestEmails(db, ops, { blIds: [blId] }, NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.unitMissing" }));
    setBlUnit(db, ops, { blIds: [blId], unitId: unitIds(culines).Mersin }, NOW);
    expect(listDueRequests(db, ops, NOW).DUE[0].rows[0]).toMatchObject({ unitMissing: false });
    expect(prepareRequestEmails(db, ops, { blIds: [blId] }, NOW)[0].to).toEqual(["mersin@culines.example"]);
  });
});
