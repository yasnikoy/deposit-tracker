import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import { setBlCustomer } from "@/server/bls";
import { createCustomer, deleteCustomer } from "@/server/customers";
import type { Db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import { prepareRequestEmails } from "@/server/email/compose";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { updateSettings } from "@/server/settings";
import { customerStandingDocuments, setStandingDocument } from "@/server/standing-documents";
import { createTestDb, makeUser } from "../support/db";
import { giveStandingDocuments, makeAgency, makeBl, PDF } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let maersk: number;
let delta: number;
let beta: number;

const upload = (name: string) => storeUpload(db, ops, { originalName: name, content: PDF, kind: "STANDING" }, NOW).id;
const bl = (blNo: string, customerId: number | null) => makeBl(db, { acc, ops }, { agencyId: maersk, blNo, amountMinor: 300000, paidAt: "2026-10-01", customerId }, NOW).blId;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "depozito@firma.com.tr" }, { key: "rules.blockSendingWithoutForm", value: false }] }, NOW);
  maersk = makeAgency(db, ops, "Maersk", { toRecipients: ["refund@maersk.example"], batchSending: true });
  delta = createCustomer(db, admin, { name: "Delta", code: null, aliases: [] }, NOW);
  beta = createCustomer(db, admin, { name: "Beta", code: null, aliases: [] }, NOW);
});

describe("a customer's standing documents", () => {
  it("are uploaded on its card by operations or an admin, named after their slot; the newest counts", () => {
    expect(() => setStandingDocument(db, acc, { customerId: delta, slot: "SIGNATURE_CIRCULAR", documentId: upload("x.pdf") }, NOW)).toThrow(ForbiddenError);
    setStandingDocument(db, ops, { customerId: delta, slot: "SIGNATURE_CIRCULAR", documentId: upload("delta imza 2025.pdf") }, NOW);
    setStandingDocument(db, ops, { customerId: delta, slot: "SIGNATURE_CIRCULAR", documentId: upload("delta imza 2026.PDF") }, NOW);
    const [doc] = customerStandingDocuments(db, [delta]).get(delta)!;
    expect(doc).toMatchObject({ slot: "SIGNATURE_CIRCULAR", originalName: "İmza sirküleri.pdf" });
    const audit = db.select().from(auditLog).where(eq(auditLog.action, "standingDocument.set")).all().at(-1)!;
    expect(audit).toMatchObject({ entityType: "customer", entityId: String(delta), after: expect.objectContaining({ uploadedName: "delta imza 2026.PDF", originalName: "İmza sirküleri.pdf" }) });
    expect(customerStandingDocuments(db, [beta]).get(beta)).toBeUndefined();
  });

  it("must both be there before a request for its B/Ls can be sent", () => {
    const a = bl("MAEU1000001", delta);
    expect(() => prepareRequestEmails(db, ops, { blIds: [a] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "requests.errors.customerDocumentsMissing", params: { bl: "MAEU1000001", customer: "Delta", documents: "İmza sirküleri, Vekaletname" } }),
    );
    setStandingDocument(db, ops, { customerId: delta, slot: "SIGNATURE_CIRCULAR", documentId: upload("imza.pdf") }, NOW);
    expect(() => prepareRequestEmails(db, ops, { blIds: [a] }, NOW)).toThrow(expect.objectContaining({ params: expect.objectContaining({ documents: "Vekaletname" }) }));
    setStandingDocument(db, ops, { customerId: delta, slot: "POWER_OF_ATTORNEY", documentId: upload("vekalet.pdf") }, NOW);
    expect(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)[0].attachments.filter((x) => x.kind === "STANDING").map((x) => x.originalName)).toEqual(["İmza sirküleri.pdf", "Vekaletname.pdf"]);
  });

  it("come from the B/L's customer, so a B/L without one is not sent", () => {
    const a = bl("MAEU1000001", null);
    expect(() => prepareRequestEmails(db, ops, { blIds: [a] }, NOW)).toThrow(expect.objectContaining({ messageKey: "requests.errors.customerMissing", params: { bl: "MAEU1000001" } }));
    giveStandingDocuments(db, ops, delta);
    setBlCustomer(db, ops, { blId: a, customerId: delta }, NOW);
    expect(prepareRequestEmails(db, ops, { blIds: [a] }, NOW)).toHaveLength(1);
  });

  it("split a batch email by customer, so no email carries two customers' documents", () => {
    giveStandingDocuments(db, ops, delta);
    giveStandingDocuments(db, ops, beta);
    const drafts = prepareRequestEmails(db, ops, { blIds: [bl("MAEU1000001", delta), bl("MAEU1000002", beta), bl("MAEU1000003", delta)] }, NOW);
    expect(drafts.map((d) => d.items.map((i) => i.blNo))).toEqual([["MAEU1000001", "MAEU1000003"], ["MAEU1000002"]]);
    expect(drafts.map((d) => d.attachments.filter((x) => x.kind === "STANDING").length)).toEqual([2, 2]);
  });

  it("are neither attached nor required while the rule setting is off", () => {
    updateSettings(db, admin, { changes: [{ key: "rules.attachStandingDocuments", value: false }] }, NOW);
    const drafts = prepareRequestEmails(db, ops, { blIds: [bl("MAEU1000001", null), bl("MAEU1000002", delta)] }, NOW);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].attachments.some((x) => x.kind === "STANDING")).toBe(false);
  });

  it("keep a customer from being deleted", () => {
    giveStandingDocuments(db, ops, beta);
    expect(() => deleteCustomer(db, admin, { id: beta, reason: "Test kaydı" }, NOW)).toThrow(expect.objectContaining({ messageKey: "customers.errors.inUse" }));
  });
});
