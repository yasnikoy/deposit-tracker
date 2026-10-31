import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAgency, updateAgencyContact } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { agencies, auditLog } from "@/server/db/schema";
import { DomainError, ForbiddenError } from "@/server/errors";
import { undoActions } from "@/server/undo";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency } from "../support/records";

const NOW = new Date("2026-10-22T09:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let msc: number;

const row = () => db.select().from(agencies).where(eq(agencies.id, msc)).get()!;

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  msc = makeAgency(db, ops, "MSC", { toRecipients: ["iade@msc.example"], notes: "Eski not" });
});

describe("inline agency contact edits", () => {
  it("change one field, audited as an agency edit; the rest of the card stays", () => {
    const [auditId] = updateAgencyContact(db, ops, { id: msc, field: "ccRecipients", value: ["muhasebe@msc.example"] }, NOW);
    expect(row()).toMatchObject({ name: "MSC", toRecipients: ["iade@msc.example"], ccRecipients: ["muhasebe@msc.example"], notes: "Eski not" });
    const audit = db.select().from(auditLog).where(eq(auditLog.id, auditId)).get()!;
    expect(audit).toMatchObject({ action: "agency.update", entityType: "agency", entityId: String(msc), roleUsed: "OPERATIONS" });
    updateAgencyContact(db, ops, { id: msc, field: "notes", value: "" }, NOW);
    expect(row().notes).toBeNull();
  });

  it("are validated like the whole card and refused for other roles", () => {
    expect(() => updateAgencyContact(db, ops, { id: msc, field: "toRecipients", value: ["not-an-address"] }, NOW)).toThrow(/agencies.errors.email/);
    expect(() => updateAgencyContact(db, ops, { id: msc, field: "toRecipients", value: ["iade@msc.example"] }, NOW)).toThrow(/noChanges/);
    expect(() => updateAgencyContact(db, acc, { id: msc, field: "notes", value: "x" }, NOW)).toThrow(ForbiddenError);
  });

  it("can be undone within the window, unless the card changed again since", () => {
    const first = updateAgencyContact(db, ops, { id: msc, field: "toRecipients", value: ["yeni@msc.example"] }, NOW);
    undoActions(db, ops, { auditIds: first }, later(1));
    expect(row().toRecipients).toEqual(["iade@msc.example"]);

    const second = updateAgencyContact(db, ops, { id: msc, field: "notes", value: "Yeni not" }, NOW);
    const card = { ...row(), portalUrl: "", notes: "Başka not" };
    updateAgency(
      db,
      ops,
      {
        id: msc,
        agency: {
          name: card.name,
          active: card.active,
          toRecipients: card.toRecipients,
          ccRecipients: card.ccRecipients,
          bankSenderAliases: card.bankSenderAliases,
          blNumberPatterns: card.blNumberPatterns,
          batchSending: card.batchSending,
          requestChannel: card.requestChannel,
          portalUrl: null,
          notes: card.notes,
        },
      },
      later(2),
    );
    expect(() => undoActions(db, ops, { auditIds: second }, later(3))).toThrow(DomainError);
    expect(row().notes).toBe("Başka not");
  });
});
