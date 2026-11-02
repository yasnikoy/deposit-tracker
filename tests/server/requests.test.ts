import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAgencyOverrides } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { voidBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { listDueRequests, previewDueImpact, updateBlOverrides } from "@/server/requests";
import { getSetting } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, NO_OVERRIDES, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul. No holidays in the test calendar.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;
let portal: number;

const bl = (agencyId: number, blNo: string, paidAt: string, currency = "USD", amountMinor = 100000) =>
  makeBl(db, { acc, ops }, { agencyId, blNo, paidAt, currency, amountMinor }, NOW).blId;
const attachForm = (blId: number) =>
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
const rows = (list: "DUE" | "UPCOMING", now = NOW) => listDueRequests(db, ops, now)[list].flatMap((g) => g.rows.map((r) => r.blNo));

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = makeAgency(db, ops, "MSC", { batchSending: true });
  portal = makeAgency(db, ops, "CMA Portal", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
});

describe("due-requests list", () => {
  it("lists due and upcoming first requests by agency, oldest due first, with totals per currency", () => {
    bl(msc, "MEDU0000003", "2026-10-15"); // due Mon 26 Oct: 2 business days left → upcoming
    bl(msc, "MEDU0000002", "2026-10-02", "EUR", 50000); // due 13 Oct
    bl(msc, "MEDU0000001", "2026-10-01"); // due 12 Oct
    bl(msc, "MEDU0000004", "2026-10-20"); // due Thu 29 Oct: not yet listed
    bl(portal, "CMAU0000001", "2026-10-05");

    const lists = listDueRequests(db, ops, NOW);
    expect(lists.formRequired).toBe(true);
    expect(lists.DUE.map((g) => [g.agencyName, g.rows.map((r) => r.blNo)])).toEqual([
      ["MSC", ["MEDU0000001", "MEDU0000002"]],
      ["CMA Portal", ["CMAU0000001"]],
    ]);
    expect(lists.DUE[0]).toMatchObject({
      batchSending: true,
      totals: [
        { currency: "USD", amountMinor: 100000 },
        { currency: "EUR", amountMinor: 50000 },
      ],
    });
    expect(lists.DUE[0].rows[0]).toMatchObject({ kind: "FIRST", attemptNo: 1, dueDate: "2026-10-12", daysWaiting: 15, channel: "EMAIL", form: null });
    expect(lists.DUE[1].rows[0]).toMatchObject({ channel: "PORTAL" });
    expect(rows("UPCOMING")).toEqual(["MEDU0000003"]);
    // Accountants follow the list read-only (sending and recording stay with operations).
    expect(listDueRequests(db, acc, NOW).DUE).toHaveLength(2);
  });

  it("shows the uploaded form and leaves voided B/Ls out", () => {
    const a = bl(msc, "MEDU0000001", "2026-10-01");
    const b = bl(msc, "MEDU0000002", "2026-10-01");
    attachForm(a);
    voidBl(db, ops, { id: b, reason: "Yanlış kayıt" }, NOW);
    const [row] = listDueRequests(db, ops, NOW).DUE[0].rows;
    expect(row).toMatchObject({ blNo: "MEDU0000001", form: { originalName: "İade formu MEDU0000001.pdf" } });
    expect(rows("DUE")).toEqual(["MEDU0000001"]);
  });

  it("applies agency and B/L overrides of the request timing", () => {
    const a = bl(msc, "MEDU0000001", "2026-10-20");
    expect(rows("DUE")).toEqual([]);
    updateAgencyOverrides(db, admin, { agencyId: msc, overrides: { ...NO_OVERRIDES, "durations.firstRequestDueDays": 2 }, reason: null }, NOW);
    expect(rows("DUE")).toEqual(["MEDU0000001"]);

    expect(() => updateBlOverrides(db, ops, { blId: a, overrides: NO_OVERRIDES, reason: null }, NOW)).toThrow(ForbiddenError);
    updateBlOverrides(db, admin, { blId: a, overrides: { ...NO_OVERRIDES, "durations.firstRequestDueDays": 10 }, reason: "Acente geç iade ediyor" }, NOW);
    expect(rows("DUE")).toEqual([]);
    expect(getSetting("durations.firstRequestDueDays", { blId: a }, db)).toBe(10);
    expect(getSetting("durations.followUpDays", { blId: a }, db)).toBe(5);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "bl.overrides")).get()).toMatchObject({ roleUsed: "ADMIN", reason: "Acente geç iade ediyor" });
  });
});

describe("impact preview", () => {
  it("counts B/Ls entering and leaving the lists under an unsaved change", () => {
    bl(msc, "MEDU0000001", "2026-10-01"); // due
    bl(msc, "MEDU0000002", "2026-10-15"); // upcoming
    bl(msc, "MEDU0000003", "2026-10-20"); // neither

    expect(previewDueImpact(db, admin, { settings: { "durations.firstRequestDueDays": 2 } }, NOW)).toEqual({
      DUE: { before: 1, after: 3, entering: 2, leaving: 0 },
      UPCOMING: { before: 1, after: 0, entering: 0, leaving: 1 },
    });
    // A Friday–Saturday weekend is evaluated too; here it leaves the due list unchanged.
    expect(previewDueImpact(db, admin, { settings: { "calendar.weekendDays": [5, 6] } }, NOW).DUE).toMatchObject({ before: 1, after: 1 });
    expect(
      previewDueImpact(db, admin, { agency: { agencyId: msc, overrides: { ...NO_OVERRIDES, "durations.upcomingDays": 0 } } }, NOW).UPCOMING,
    ).toEqual({ before: 1, after: 0, entering: 0, leaving: 1 });
    // Nothing was saved.
    expect(rows("DUE")).toEqual(["MEDU0000001"]);
    expect(() => previewDueImpact(db, ops, { settings: { "durations.firstRequestDueDays": 2 } }, NOW)).toThrow(ForbiddenError);
  });
});
