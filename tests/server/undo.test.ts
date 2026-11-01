import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation } from "@/server/allocations";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import { updateBl } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { auditLog, billsOfLading, deductionTypes, emailMatchSuggestions, emails, replyTypes } from "@/server/db/schema";
import { recordStatementDeductions } from "@/server/deductions";
import { ForbiddenError } from "@/server/errors";
import { storeUpload } from "@/server/files";
import { currentBlForm, uploadBlForm } from "@/server/forms";
import { createRefund } from "@/server/refunds";
import { acceptSuggestion, getReplyDetail, recordEmailReplies, recordReplyWithoutEmail } from "@/server/replies";
import { recordPortalRequest } from "@/server/requests";
import { undoActions } from "@/server/undo";
import { createTestDb, makeUser } from "../support/db";
import { makeAgency, makeBl, PDF, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul; the undo window is 10 minutes (seed).
const NOW = new Date("2026-10-22T09:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;
let acc: AuthUser;
let ops: AuthUser;
let ops2: AuthUser;
let line: number;
let bl: number;

const status = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.status;
const replyType = (code: string) => db.select().from(replyTypes).where(eq(replyTypes.code, code as never)).get()!.id;
const upload = (kind: "FORM" | "DEDUCTION_STATEMENT", name = "f.pdf") => storeUpload(db, ops, { originalName: name, content: PDF, kind }, NOW).id;

function incomingEmail(messageId: string): number {
  return db
    .insert(emails)
    .values({ direction: "IN", agencyId: line, messageId, fromAddress: "iade@hat.example", to: [], subject: "B/L HATU1000001", bodyText: "...", receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() })
    .returning()
    .get().id;
}

beforeEach(async () => {
  db = createTestDb();
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  ops2 = await makeUser(db, "ops2", ["OPERATIONS"]);
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example" });
  bl = makeBl(db, { acc, ops }, { agencyId: line, blNo: "HATU1000001", paidAt: "2026-08-03", amountMinor: 150000, containers: ["MSCU1234565"] }, NOW).blId;
  uploadBlForm(db, ops, { blId: bl, documentId: upload("FORM") }, NOW);
  recordPortalRequest(db, ops, { blId: bl, requestedOn: "2026-09-01", portalRef: null }, NOW);
});

describe("undo", () => {
  it("takes back the user's own reply within the window; a 'not yet returned' reply returns the B/L to REQUESTED", () => {
    const ids = recordReplyWithoutEmail(db, ops, { blId: bl, replyTypeId: replyType("NOT_RETURNED"), repliedOn: "2026-10-21", note: null }, NOW);
    expect(status(bl)).toBe("AWAITING_RETURN");
    expect(() => undoActions(db, ops2, { auditIds: ids }, later(1))).toThrow(expect.objectContaining({ messageKey: "undo.errors.notOwn" }));
    expect(() => undoActions(db, acc, { auditIds: ids }, later(1))).toThrow(expect.objectContaining({ messageKey: "undo.errors.notOwn" }));

    undoActions(db, ops, { auditIds: ids }, later(2));
    expect(status(bl)).toBe("REQUESTED");
    const detail = getBlDetail(db, ops, bl, later(2));
    expect(detail.bl.lastReply).toBeNull();
    expect(detail.replies).toEqual([expect.objectContaining({ undone: true })]);
    expect(detail.timeline.find((e) => e.action === "undo")).toMatchObject({ undoOfAction: "reply.record" });
    expect(() => undoActions(db, ops, { auditIds: ids }, later(3))).toThrow(expect.objectContaining({ messageKey: "undo.errors.alreadyUndone" }));
  });

  it("is refused after the undo window, and for actions rule 17 excludes", () => {
    const ids = recordReplyWithoutEmail(db, ops, { blId: bl, replyTypeId: replyType("APPROVED"), repliedOn: "2026-10-21", note: null }, NOW);
    expect(() => undoActions(db, ops, { auditIds: ids }, later(11))).toThrow(expect.objectContaining({ messageKey: "undo.errors.expired", params: { minutes: 10 } }));

    const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, NOW);
    const refund = createRefund(db, acc, { agencyId: line, customerId: testCustomer(db), amountMinor: 150000, currency: "USD", valueDate: "2026-10-22", kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true }, NOW);
    if (refund.status !== "created") throw new Error("refund");
    confirmAllocation(db, ops, { refundId: refund.id, lines: allocationProposal(db, ops, refund.id).suggestions.exact[0], shortfall: null, remainderReason: null }, NOW);
    const allocationAudit = db.select().from(auditLog).where(eq(auditLog.action, "allocation.confirm")).get()!;
    expect(() => undoActions(db, ops, { auditIds: [allocationAudit.id] }, later(1))).toThrow(expect.objectContaining({ messageKey: "undo.errors.notUndoable" }));
    expect(status(bl)).toBe("COLLECTED");
  });

  it("is checked against the permission of the original action (here: the operations role was taken away)", async () => {
    const both = await makeUser(db, "both", ["OPERATIONS", "ACCOUNTANT"]);
    const ids = recordReplyWithoutEmail(db, both, { blId: bl, replyTypeId: replyType("INFO"), repliedOn: "2026-10-21", note: null }, NOW);
    expect(() => undoActions(db, { ...both, roles: ["ACCOUNTANT"] }, { auditIds: ids }, later(1))).toThrow(ForbiddenError);
  });

  it("of a statement deduction compensates it and reopens a B/L it closed", () => {
    const demurrage = db.select().from(deductionTypes).all().find((t) => t.code === null)!.id;
    const ids = recordStatementDeductions(db, ops, { blId: bl, documentId: upload("DEDUCTION_STATEMENT"), lines: [{ deductionTypeId: demurrage, amountMinor: 150000 }] }, NOW);
    expect(status(bl)).toBe("ACCOUNTING_PENDING");
    undoActions(db, ops, { auditIds: ids }, later(5));
    expect(status(bl)).toBe("REQUESTED");
    expect(getBlDetail(db, ops, bl, later(5)).bl).toMatchObject({ deductionsMinor: 0, expectedMinor: 150000 });
  });

  it("of an email link unlinks it while no reply was recorded; an accepted match is offered again", () => {
    const first = incomingEmail("<m1@hat.example>");
    db.insert(emailMatchSuggestions).values({ emailId: first, blId: bl, createdAt: NOW.toISOString() }).run();
    const ids = acceptSuggestion(db, ops, { emailId: first, blId: bl }, NOW);
    undoActions(db, ops, { auditIds: ids }, later(1));
    expect(getReplyDetail(db, ops, first)).toMatchObject({ links: [], suggestions: [expect.objectContaining({ blId: bl })] });
    expect(getBlDetail(db, ops, bl, later(1)).emails).toEqual([]);

    // Linked again and answered: the link stays.
    const again = acceptSuggestion(db, ops, { emailId: first, blId: bl }, later(2));
    expect(getReplyDetail(db, ops, first).links).toHaveLength(1);
    recordEmailReplies(db, ops, { items: [{ emailId: first, blId: bl }], replyTypeId: replyType("APPROVED") }, later(2));
    expect(() => undoActions(db, ops, { auditIds: again }, later(3))).toThrow(expect.objectContaining({ messageKey: "undo.errors.replyRecorded" }));
  });

  it("of a form upload makes the previous form current again; of a B/L edit restores number and containers", () => {
    const fresh = makeBl(db, { acc, ops }, { agencyId: line, blNo: "HATU1000002", paidAt: "2026-10-20", amountMinor: 1000, containers: [] }, NOW).blId;
    const firstForm = uploadBlForm(db, ops, { blId: fresh, documentId: upload("FORM", "ilk.pdf") }, NOW);
    expect(firstForm).toHaveLength(1);
    const before = currentBlForm(db, fresh)!.id;
    const ids = uploadBlForm(db, ops, { blId: fresh, documentId: upload("FORM", "yeni.pdf") }, NOW);
    undoActions(db, ops, { auditIds: ids }, later(1));
    expect(currentBlForm(db, fresh)!.id).toBe(before);
    expect(getBlDetail(db, ops, fresh, later(1)).documents.filter((d) => d.withdrawn)).toHaveLength(1);

    const edit = updateBl(db, ops, { id: fresh, blNo: "HATU1000003", containers: ["MSCU1234565"] }, NOW);
    expect(getBlDetail(db, ops, fresh, NOW).bl).toMatchObject({ blNo: "HATU1000003", containers: ["MSCU1234565"] });
    undoActions(db, ops, { auditIds: edit }, later(1));
    expect(getBlDetail(db, ops, fresh, later(1)).bl).toMatchObject({ blNo: "HATU1000002", containers: [] });
    expect(currentBlForm(db, fresh)!.originalName).toBe("İade formu HATU1000002.pdf");
  });

  it("is offered on the viewer's own recent timeline events only", () => {
    recordReplyWithoutEmail(db, ops, { blId: bl, replyTypeId: replyType("APPROVED"), repliedOn: "2026-10-21", note: null }, NOW);
    const own = getBlDetail(db, ops, bl, later(1)).timeline.find((e) => e.action === "reply.record")!;
    expect(own.undoable).toBe(true);
    expect(getBlDetail(db, ops2, bl, later(1)).timeline.find((e) => e.action === "reply.record")!.undoable).toBe(false);
    expect(getBlDetail(db, ops, bl, later(11)).timeline.find((e) => e.action === "reply.record")!.undoable).toBe(false);
    expect(db.select().from(auditLog).where(and(eq(auditLog.action, "undo"))).all()).toEqual([]);
  });
});
