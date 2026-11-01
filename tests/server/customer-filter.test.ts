import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { listAllBls, getBlDetail, searchBls } from "@/server/bl-overview";
import { createCustomer } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { billsOfLading } from "@/server/db/schema";
import { listNotifications, notify, unreadNotificationCount } from "@/server/notifications";
import { getCustomerFilter, saveCustomerFilter } from "@/server/preferences";
import { listDueRequests } from "@/server/requests";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let ops2: AuthUser;
let ornek: number;
let beta: number;
let bls: { ornek: number; beta: number; none: number };

const setCustomer = (blId: number, customerId: number | null) => db.update(billsOfLading).set({ customerId }).where(eq(billsOfLading.id, blId)).run();
const blNos = (user: AuthUser) => listAllBls(db, user, NOW).map((b) => b.blNo).sort();

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  ops2 = await makeUser(db, "ops2", ["OPERATIONS"]);
  const msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"] });
  ornek = createCustomer(db, admin, { name: "Ornek", code: null, aliases: [] }, NOW);
  beta = createCustomer(db, admin, { name: "Beta", code: null, aliases: [] }, NOW);
  const make = (blNo: string) => makeBl(db, { acc, ops }, { agencyId: msc, blNo, amountMinor: 100000, paidAt: "2026-07-01" }, NOW).blId;
  bls = { ornek: make("MEDU1000001"), beta: make("MEDU1000002"), none: make("MEDU1000003") };
  setCustomer(bls.ornek, ornek);
  setCustomer(bls.beta, beta);
  setCustomer(bls.none, null);
});

describe("customer filter", () => {
  it("is a personal setting: none selected shows every customer", () => {
    expect(getCustomerFilter(db, ops.id)).toEqual([]);
    expect(blNos(ops)).toEqual(["MEDU1000001", "MEDU1000002", "MEDU1000003"]);
    saveCustomerFilter(db, ops, [ornek, ornek], NOW);
    expect(getCustomerFilter(db, ops.id)).toEqual([ornek]);
    expect(() => saveCustomerFilter(db, ops, [9999], NOW)).toThrow(/customers.errors.unknown/);
    // Another user's view is unchanged.
    expect(blNos(ops2)).toHaveLength(3);
  });

  it("narrows lists, search and due requests to the followed customers; B/Ls without a customer stay", () => {
    saveCustomerFilter(db, ops, [ornek], NOW);
    expect(blNos(ops)).toEqual(["MEDU1000001", "MEDU1000003"]);
    expect(searchBls(db, ops, "MEDU100000", NOW).items.map((i) => i.blNo).sort()).toEqual(["MEDU1000001", "MEDU1000003"]);
    const due = listDueRequests(db, ops, NOW).DUE.flatMap((g) => g.rows).map((r) => r.blNo).sort();
    expect(due).toEqual(["MEDU1000001", "MEDU1000003"]);
    // Opening a record directly is never blocked.
    expect(getBlDetail(db, ops, bls.beta, NOW).bl.blNo).toBe("MEDU1000002");
  });

  it("hides notifications about B/Ls of other customers, and leaves other notifications", () => {
    for (const blId of [bls.ornek, bls.beta]) {
      notify(db, { userIds: [ops.id], actorId: null, kind: "MENTION", entityType: "bill_of_lading", entityId: blId, detail: { author: "X", blNo: "B", excerpt: "e" } }, NOW);
    }
    notify(db, { userIds: [ops.id], actorId: null, kind: "NEW_AGENCY", entityType: "agency", entityId: 1, detail: { actor: "A", agency: "Yeni" } }, NOW);
    expect(unreadNotificationCount(db, ops)).toBe(3);
    saveCustomerFilter(db, ops, [ornek], NOW);
    expect(listNotifications(db, ops).map((n) => [n.entityType, n.entityId])).toEqual([
      ["agency", 1],
      ["bill_of_lading", bls.ornek],
    ]);
    expect(unreadNotificationCount(db, ops)).toBe(2);
  });
});
