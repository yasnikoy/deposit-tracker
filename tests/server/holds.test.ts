import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { holdBl, releaseHold } from "@/server/holds";
import { listHoldReasons } from "@/server/lists";
import { positions } from "@/server/reports";
import { listDueRequests } from "@/server/requests";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl } from "../support/records";

// Tuesday 10 Nov 2026, 12:00 Istanbul.
const NOW = new Date("2026-11-10T09:00:00Z");

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let blId: number;

const dueBls = (now = NOW) => listDueRequests(db, ops, now).DUE.flatMap((g) => g.rows.map((r) => r.blNo));
const reason = () => listHoldReasons(db, ops)[0].id;

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  const msc = makeAgency(db, ops, "MSC");
  // Paid in July: its first request is long due.
  blId = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000001", amountMinor: 300000, paidAt: "2026-07-01" }, NOW).blId;
});

describe("putting a B/L on hold", () => {
  it("takes it off the due list while the money stays outstanding; lifting brings it back", () => {
    expect(dueBls()).toEqual(["MEDU1000001"]);
    expect(() => holdBl(db, acc, { blIds: [blId], reasonId: reason(), note: null, until: null }, NOW)).toThrow(ForbiddenError);
    holdBl(db, ops, { blIds: [blId], reasonId: reason(), note: "Avukata devredildi", until: null }, NOW);
    expect(dueBls()).toEqual([]);
    expect(positions(db, ops, NOW).find((p) => p.blNo === "MEDU1000001")).toMatchObject({ open: true, outstandingMinor: 300000 });

    releaseHold(db, ops, { blIds: [blId] }, NOW);
    expect(dueBls()).toEqual(["MEDU1000001"]);
    expect(() => releaseHold(db, ops, { blIds: [blId] }, NOW)).toThrow(expect.objectContaining({ messageKey: "holds.errors.notHeld" }));
  });

  it("comes back by itself on its review date, which must lie ahead", () => {
    expect(() => holdBl(db, ops, { blIds: [blId], reasonId: reason(), note: null, until: "2026-11-10" }, NOW)).toThrow(expect.objectContaining({ messageKey: "holds.errors.untilPast" }));
    holdBl(db, ops, { blIds: [blId], reasonId: reason(), note: null, until: "2026-12-01" }, NOW);
    expect(dueBls(new Date("2026-11-30T09:00:00Z"))).toEqual([]);
    expect(dueBls(new Date("2026-12-01T09:00:00Z"))).toEqual(["MEDU1000001"]);
  });

  it("holds and lifts several B/Ls together, or none when one cannot be held", () => {
    const msc = listDueRequests(db, ops, NOW).DUE[0].agencyId;
    const other = makeBl(db, { acc, ops }, { agencyId: msc, blNo: "MEDU1000002", amountMinor: 300000, paidAt: "2026-07-01" }, NOW).blId;
    holdBl(db, ops, { blIds: [blId, other], reasonId: reason(), note: null, until: null }, NOW);
    expect(dueBls()).toEqual([]);
    releaseHold(db, ops, { blIds: [other] }, NOW);
    // One of them is not on hold any more: nothing is lifted.
    expect(() => releaseHold(db, ops, { blIds: [blId, other] }, NOW)).toThrow(expect.objectContaining({ messageKey: "holds.errors.notHeld", params: { bl: "MEDU1000002" } }));
    expect(dueBls()).toEqual(["MEDU1000002"]);
    releaseHold(db, ops, { blIds: [blId] }, NOW);
    expect(dueBls()).toEqual(["MEDU1000001", "MEDU1000002"]);
  });
});
