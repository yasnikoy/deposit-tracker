import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { allocationProposal, confirmAllocation, reverseAllocation } from "@/server/allocations";
import { updateAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { getBlDetail } from "@/server/bl-overview";
import type { Db } from "@/server/db/client";
import { billsOfLading, deductionTypes, emailAttachments, emailBlLinks, emails, requests } from "@/server/db/schema";
import { classifyDeduction, disputeDeduction, recordStatementDeductions } from "@/server/deductions";
import { prepareRequestEmails } from "@/server/email/compose";
import { emailJobHandlers, queueRequestEmail } from "@/server/email/send";
import type { MailTransport } from "@/server/email/transport";
import { ForbiddenError } from "@/server/errors";
import { storeImportedDocument, storeUpload } from "@/server/files";
import { uploadBlForm } from "@/server/forms";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { createRefund } from "@/server/refunds";
import { listDueRequests, recordPortalRequest } from "@/server/requests";
import { updateSettings } from "@/server/settings";
import { approveWriteOff, listWriteOffs, proposeWriteOff, rejectWriteOff } from "@/server/write-offs";
import { createTestDb, makeUser } from "../support/db";
import { agencyInputSchema } from "@/lib/schemas/agencies";
import { makeAgency, makeBl, PDF, testCustomer } from "../support/records";

// Thursday 22 Oct 2026, 12:00 Istanbul.
const NOW = new Date("2026-10-22T09:00:00Z");
// Monday 26 Oct: two business days later.
const MONDAY = new Date("2026-10-26T09:00:00Z");
const usd = (amount: number) => amount * 100;

let db: Db;
let admin: AuthUser;
let acc: AuthUser;
let ops: AuthUser;
let line: number;
let a: number, b: number, c: number;

function requestedBl(blNo: string, amount: number, requestedOn: string): number {
  const { blId } = makeBl(db, { acc, ops }, { agencyId: line, blNo, paidAt: "2026-08-03", amountMinor: usd(amount) }, NOW);
  uploadBlForm(db, ops, { blId, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
  recordPortalRequest(db, ops, { blId, requestedOn, portalRef: null }, NOW);
  return blId;
}

function refund(amount: number, at = NOW): number {
  const evidence = storeUpload(db, acc, { originalName: "iade.pdf", content: PDF, kind: "RECEIPT" }, at);
  const result = createRefund(
    db,
    acc,
    { agencyId: line, customerId: testCustomer(db), amountMinor: usd(amount), currency: "USD", valueDate: at.toISOString().slice(0, 10), kind: "BANK", evidenceDocumentId: evidence.id, confirmDuplicate: true },
    at,
  );
  if (result.status !== "created") throw new Error("refund not created");
  return result.id;
}

const statement = (user = ops) => storeUpload(db, user, { originalName: "kesinti-dokumu.pdf", content: PDF, kind: "DEDUCTION_STATEMENT" }, NOW).id;
const typeId = (code: string | null, name?: string) =>
  db
    .select()
    .from(deductionTypes)
    .all()
    .find((t) => t.code === code && (!name || t.name === name))!.id;
const demurrage = () => typeId(null, "Demuraj / detention");
const status = (blId: number) => db.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get()!.status;
const balance = (blId: number) => getBlDetail(db, ops, blId, NOW).bl;
const unexplainedEntry = (blId: number) =>
  getBlDetail(db, ops, blId, NOW).ledger.find((l) => l.deduction?.code === "UNEXPLAINED" && !l.compensated && l.compensatesEntryId === null)!;

/** Refund 6,300 over A 3,000 + B 2,500 + C 1,500: C bears an unexplained 700 shortfall. */
function shortfallOnC(): number[] {
  const r = refund(6300);
  const { fifo } = allocationProposal(db, ops, r).suggestions;
  return confirmAllocation(db, ops, { refundId: r, lines: fifo.lines, shortfall: { blId: c, amountMinor: usd(700), deductionTypeId: typeId("UNEXPLAINED") }, remainderReason: null }, NOW);
}

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  line = makeAgency(db, ops, "Hat Lojistik", { requestChannel: "PORTAL", portalUrl: "https://portal.example", toRecipients: ["iade@hat.example"] });
  a = requestedBl("HATU1000001", 3000, "2026-09-01");
  b = requestedBl("HATU1000002", 2500, "2026-09-05");
  c = requestedBl("HATU1000003", 1500, "2026-09-10");
});

describe("deductions from a statement before payment", () => {
  it("lower the expected amount without a status change, so the later refund matches exactly", () => {
    const input = { blId: c, documentId: statement(), lines: [{ deductionTypeId: typeId(null, "Diğer"), amountMinor: usd(700) }] };
    expect(() => recordStatementDeductions(db, acc, input, NOW)).toThrow(ForbiddenError);
    recordStatementDeductions(db, ops, input, NOW);
    expect(status(c)).toBe("REQUESTED");
    expect(balance(c)).toMatchObject({ deductionsMinor: usd(700), expectedMinor: usd(800) });
    // The statement is kept on the B/L and on the ledger line.
    const detail = getBlDetail(db, ops, c, NOW);
    expect(detail.documents.map((d) => d.kind)).toContain("DEDUCTION_STATEMENT");
    expect(detail.ledger[0].deduction).toMatchObject({ source: "STATEMENT", documentId: input.documentId });

    const r = refund(6300);
    const { exact } = allocationProposal(db, ops, r).suggestions;
    expect(exact[0]).toEqual([
      { blId: a, amountMinor: usd(3000) },
      { blId: b, amountMinor: usd(2500) },
      { blId: c, amountMinor: usd(800) },
    ]);
    confirmAllocation(db, ops, { refundId: r, lines: exact[0], shortfall: null, remainderReason: null }, NOW);
    expect([status(a), status(b), status(c)]).toEqual(["COLLECTED", "COLLECTED", "ACCOUNTING_PENDING"]);
  });

  it("need a real type, a statement, a requested B/L, and must leave something to refund", () => {
    const line700 = [{ deductionTypeId: demurrage(), amountMinor: usd(700) }];
    expect(() => recordStatementDeductions(db, ops, { blId: c, documentId: statement(), lines: [{ deductionTypeId: typeId("UNEXPLAINED"), amountMinor: usd(1) }] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "deductions.errors.type" }),
    );
    expect(() => recordStatementDeductions(db, ops, { blId: c, documentId: statement(), lines: [{ deductionTypeId: demurrage(), amountMinor: usd(1500) + 1 }] }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "deductions.errors.exceedsExpected" }),
    );
    // A receipt, or someone else's upload, is not a statement.
    const receipt = storeUpload(db, ops, { originalName: "d.pdf", content: PDF, kind: "RECEIPT" }, NOW).id;
    expect(() => recordStatementDeductions(db, ops, { blId: c, documentId: receipt, lines: line700 }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "files.errors.evidence" }),
    );
    const ops2Upload = storeUpload(db, admin, { originalName: "k.pdf", content: PDF, kind: "DEDUCTION_STATEMENT" }, NOW).id;
    expect(() => recordStatementDeductions(db, ops, { blId: c, documentId: ops2Upload, lines: line700 }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "files.errors.evidence" }),
    );
    const paid = makeBl(db, { acc, ops }, { agencyId: line, blNo: "HATU1000009", paidAt: "2026-10-20", amountMinor: usd(1000) }, NOW).blId;
    expect(() => recordStatementDeductions(db, ops, { blId: paid, documentId: statement(), lines: line700 }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "deductions.errors.statementStatus" }),
    );
  });

  it("that take the whole deposit (e.g. applied to an agency invoice) close the B/L as collected", () => {
    recordStatementDeductions(
      db,
      ops,
      {
        blId: c,
        documentId: statement(),
        lines: [
          { deductionTypeId: demurrage(), amountMinor: usd(1000) },
          { deductionTypeId: typeId(null, "Diğer"), amountMinor: usd(500) },
        ],
      },
      NOW,
    );
    expect(status(c)).toBe("ACCOUNTING_PENDING");
    expect(balance(c)).toMatchObject({ collectedMinor: 0, deductionsMinor: usd(1500), expectedMinor: 0 });
    // Closed: no more requests, no allocation candidate, nothing to write off.
    expect(listDueRequests(db, ops, MONDAY).DUE.flatMap((g) => g.rows).map((r) => r.blId)).not.toContain(c);
    expect(allocationProposal(db, ops, refund(5500)).candidates.map((x) => x.blId)).toEqual([a, b]);
    expect(() => proposeWriteOff(db, ops, { blId: c, reason: "x" }, NOW)).toThrow(expect.objectContaining({ messageKey: "writeOffs.errors.closed" }));
  });

  it("may take the statement from an agency email linked to the B/L", () => {
    const email = db
      .insert(emails)
      .values({ direction: "IN", agencyId: line, messageId: "<k1@hat.example>", fromAddress: "iade@hat.example", to: [], subject: "Kesinti", bodyText: "Ekte", receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() })
      .returning()
      .get();
    const doc = storeImportedDocument(db, { originalName: "dokum.pdf", content: PDF, mimeType: "application/pdf", ownerType: "email", ownerId: email.id }, NOW);
    db.insert(emailAttachments).values({ emailId: email.id, documentId: doc.id }).run();
    const input = { blId: c, documentId: doc.id, lines: [{ deductionTypeId: demurrage(), amountMinor: usd(200) }] };
    expect(() => recordStatementDeductions(db, ops, input, NOW)).toThrow(expect.objectContaining({ messageKey: "deductions.errors.statementDocument" }));
    db.insert(emailBlLinks).values({ emailId: email.id, blId: c, linkedBy: "MANUAL", linkedByUser: ops.id, createdAt: NOW.toISOString() }).run();
    recordStatementDeductions(db, ops, input, NOW);
    expect(balance(c).expectedMinor).toBe(usd(1300));
  });
});

describe("an unexplained shortfall", () => {
  beforeEach(() => shortfallOnC());

  it("is classified with its real type once the statement arrives, which closes the B/L", () => {
    const entry = unexplainedEntry(c);
    expect(() => classifyDeduction(db, ops, { entryId: entry.id, lines: [{ deductionTypeId: demurrage(), amountMinor: usd(500) }], documentId: null, note: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "deductions.errors.mustEqual" }),
    );
    classifyDeduction(
      db,
      ops,
      {
        entryId: entry.id,
        lines: [
          { deductionTypeId: demurrage(), amountMinor: usd(500) },
          { deductionTypeId: typeId(null, "Diğer"), amountMinor: usd(200) },
        ],
        documentId: statement(),
        note: null,
      },
      NOW,
    );
    expect(status(c)).toBe("ACCOUNTING_PENDING");
    expect(balance(c)).toMatchObject({ deductionsMinor: usd(700), expectedMinor: 0 });
    expect(getBlDetail(db, ops, c, NOW).timeline.map((e) => e.action)).toContain("deduction.classify");
  });

  it("asks the agency for a statement after the statement-request delay, by email even for a portal agency", async () => {
    expect(listDueRequests(db, ops, NOW).UPCOMING[0].rows).toEqual([
      expect.objectContaining({ blId: c, type: "DEDUCTION_STATEMENT", kind: "FIRST", amountMinor: usd(700), channel: "EMAIL", needsForm: false, dueDate: "2026-10-26" }),
    ]);
    const [draft] = prepareRequestEmails(db, ops, { blIds: [c] }, MONDAY);
    expect(draft.subject).toBe("Depozito Kesinti Dökümü Talebi – HATU1000003");
    expect(draft.body).toContain("700,00 USD tutarında fark");
    expect(draft.items).toEqual([expect.objectContaining({ type: "DEDUCTION_STATEMENT", attemptNo: 1 })]);

    updateSettings(db, admin, { changes: [{ key: "email.fromAddress", value: "depozito@firma.com.tr" }], reason: null }, NOW);
    queueRequestEmail(
      db,
      ops,
      { blIds: [c], to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, documentIds: draft.attachments.map((x) => x.documentId) },
      MONDAY,
    );
    const transport: MailTransport = { dryRun: true, async send() {}, async appendToSent() {} };
    await runDueJobs(db, emailJobHandlers(db, () => transport) as JobHandlers, () => MONDAY);
    // A statement request changes no status; the follow-up waits for the statement follow-up interval.
    expect(status(c)).toBe("DEDUCTION_OPEN");
    expect(db.select().from(requests).where(eq(requests.blId, c)).all().filter((r) => r.type === "DEDUCTION_STATEMENT")).toEqual([
      expect.objectContaining({ sendStatus: "SENT", attemptNo: 1, requestedOn: "2026-10-26" }),
    ]);
    const later = listDueRequests(db, ops, new Date("2026-11-02T09:00:00Z")).DUE.flatMap((g) => g.rows);
    expect(later).toEqual([expect.objectContaining({ blId: c, type: "DEDUCTION_STATEMENT", kind: "FOLLOW_UP", attemptNo: 2 })]);
    const [followUp] = prepareRequestEmails(db, ops, { blIds: [c] }, new Date("2026-11-02T09:00:00Z"));
    expect(followUp.subject).toBe("Re: Depozito Kesinti Dökümü Talebi – HATU1000003");
  });

  it("joins a refund request in one batched email, each in its own section", () => {
    updateAgency(
      db,
      ops,
      {
        id: line,
        agency: agencyInputSchema.parse({
          name: "Hat Lojistik",
          active: true,
          toRecipients: ["iade@hat.example"],
          ccRecipients: [],
          bankSenderAliases: [],
          blNumberPatterns: [],
          batchSending: true,
          requestChannel: "EMAIL",
          portalUrl: "",
          notes: "",
        }),
      },
      NOW,
    );
    const { blId: d } = makeBl(db, { acc, ops }, { agencyId: line, blNo: "HATU1000004", paidAt: "2026-10-01", amountMinor: usd(2000) }, NOW);
    uploadBlForm(db, ops, { blId: d, documentId: storeUpload(db, ops, { originalName: "form.pdf", content: PDF, kind: "FORM" }, NOW).id }, NOW);
    const drafts = prepareRequestEmails(db, ops, { blIds: [c, d] }, MONDAY);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("Depozito Talepleri – HATU1000003, HATU1000004");
    expect(drafts[0].body).toContain("depozito iadelerini rica ederiz:\n• HATU1000004 –  – 2.000,00 USD");
    expect(drafts[0].body).toContain("kesinti dökümünü rica ederiz:\n• HATU1000003 –  – 700,00 USD");
  });

  it("is disputed with a note; a later refund of the difference closes the B/L, and reversing it reopens the dispute", () => {
    const entry = unexplainedEntry(c);
    expect(() => disputeDeduction(db, acc, { entryId: entry.id, note: "Konteyner temiz teslim edildi" }, NOW)).toThrow(ForbiddenError);
    disputeDeduction(db, ops, { entryId: entry.id, note: "Konteyner temiz teslim edildi" }, NOW);
    expect(status(c)).toBe("DISPUTED");
    expect(unexplainedEntry(c).deduction).toMatchObject({ disputed: true, disputeNote: "Konteyner temiz teslim edildi" });
    expect(() => disputeDeduction(db, ops, { entryId: entry.id, note: "tekrar" }, NOW)).toThrow(expect.objectContaining({ messageKey: "deductions.errors.alreadyDisputed" }));
    // No statement request while disputed.
    expect(listDueRequests(db, ops, MONDAY).DUE).toEqual([]);

    const r2 = refund(700, MONDAY);
    const proposal = allocationProposal(db, ops, r2);
    expect(proposal.candidates).toEqual([expect.objectContaining({ blId: c, expectedMinor: usd(700), disputedEntryId: entry.id })]);
    expect(() =>
      confirmAllocation(db, ops, { refundId: r2, lines: [{ blId: c, amountMinor: usd(500) }], shortfall: { blId: c, amountMinor: usd(200), deductionTypeId: demurrage() }, remainderReason: "x" }, MONDAY),
    ).toThrow(expect.objectContaining({ messageKey: "allocations.errors.disputedShortfall" }));
    const [paid] = confirmAllocation(db, ops, { refundId: r2, lines: [{ blId: c, amountMinor: usd(700) }], shortfall: null, remainderReason: null }, MONDAY);
    expect(status(c)).toBe("COLLECTED");
    expect(balance(c)).toMatchObject({ collectedMinor: usd(1500), deductionsMinor: 0, expectedMinor: 0 });

    // The first allocation can only be reversed after the later one.
    const first = getBlDetail(db, ops, c, NOW).allocations.find((x) => x.id !== paid)!;
    expect(() => reverseAllocation(db, admin, { allocationId: first.id, reason: "x" }, MONDAY)).toThrow(
      expect.objectContaining({ messageKey: "allocations.errors.laterAllocation" }),
    );
    reverseAllocation(db, admin, { allocationId: paid, reason: "Yanlış iade" }, MONDAY);
    expect(status(c)).toBe("DISPUTED");
    expect(balance(c)).toMatchObject({ collectedMinor: usd(800), deductionsMinor: usd(700), expectedMinor: 0 });
    expect(unexplainedEntry(c).deduction).toMatchObject({ disputed: true });
    // And the original allocation then reverses as before.
    reverseAllocation(db, admin, { allocationId: first.id, reason: "Yanlış B/L" }, MONDAY);
    expect(status(c)).toBe("REQUESTED");
    expect(balance(c)).toMatchObject({ collectedMinor: 0, deductionsMinor: 0, expectedMinor: usd(1500) });
  });

  it("is accepted by clearing the dispute with a note and a real type", () => {
    disputeDeduction(db, ops, { entryId: unexplainedEntry(c).id, note: "İtiraz" }, NOW);
    const lines = [{ deductionTypeId: demurrage(), amountMinor: usd(700) }];
    expect(() => classifyDeduction(db, ops, { entryId: unexplainedEntry(c).id, lines, documentId: null, note: null }, NOW)).toThrow(
      expect.objectContaining({ messageKey: "deductions.errors.clearNote" }),
    );
    classifyDeduction(db, ops, { entryId: unexplainedEntry(c).id, lines, documentId: null, note: "Acentenin dökümü kabul edildi" }, NOW);
    expect(status(c)).toBe("ACCOUNTING_PENDING");
    expect(getBlDetail(db, ops, c, NOW).timeline.map((e) => e.action)).toContain("deduction.disputeCleared");
  });
});

describe("write-offs", () => {
  it("close a B/L only once an admin approves; an unapproved one changes nothing", () => {
    shortfallOnC();
    expect(() => proposeWriteOff(db, admin, { blId: c, reason: "Tutar takibe değmez" }, NOW)).toThrow(ForbiddenError);
    const id = proposeWriteOff(db, ops, { blId: c, reason: "Tutar takibe değmez" }, NOW);
    expect(status(c)).toBe("DEDUCTION_OPEN");
    expect(() => proposeWriteOff(db, ops, { blId: c, reason: "tekrar" }, NOW)).toThrow(expect.objectContaining({ messageKey: "writeOffs.errors.pending" }));
    expect(listWriteOffs(db, admin).pending).toEqual([expect.objectContaining({ id, blNo: "HATU1000003", amountMinor: usd(700), currentAmountMinor: usd(700) })]);

    expect(() => approveWriteOff(db, ops, { writeOffId: id, note: null }, NOW)).toThrow(ForbiddenError);
    approveWriteOff(db, admin, { writeOffId: id, note: null }, NOW);
    expect(status(c)).toBe("ACCOUNTING_PENDING");
    // The write-off replaces the unexplained deduction.
    expect(balance(c)).toMatchObject({ deductionsMinor: usd(700), expectedMinor: 0 });
    expect(unexplainedEntry(c)).toBeUndefined();
    expect(getBlDetail(db, ops, c, NOW).writeOffs).toEqual([expect.objectContaining({ state: "APPROVED" })]);
    expect(() => approveWriteOff(db, admin, { writeOffId: id, note: null }, NOW)).toThrow(expect.objectContaining({ messageKey: "writeOffs.errors.decided" }));
  });

  it("cover the whole rest of a requested B/L, are refused once the B/L changed, and can be rejected", () => {
    const id = proposeWriteOff(db, ops, { blId: a, reason: "Acente kapandı" }, NOW);
    expect(listWriteOffs(db, admin).pending[0]).toMatchObject({ amountMinor: usd(3000) });
    recordStatementDeductions(db, ops, { blId: a, documentId: statement(), lines: [{ deductionTypeId: demurrage(), amountMinor: usd(100) }] }, NOW);
    expect(listWriteOffs(db, admin).pending[0]).toMatchObject({ amountMinor: usd(3000), currentAmountMinor: usd(2900) });
    expect(() => approveWriteOff(db, admin, { writeOffId: id, note: null }, NOW)).toThrow(expect.objectContaining({ messageKey: "writeOffs.errors.amountChanged" }));
    rejectWriteOff(db, admin, { writeOffId: id, reason: "Tutar değişti, yeniden önerin" }, NOW);
    expect(status(a)).toBe("REQUESTED");

    const again = proposeWriteOff(db, ops, { blId: a, reason: "Acente kapandı" }, NOW);
    approveWriteOff(db, admin, { writeOffId: again, note: "Onaylandı" }, NOW);
    expect(status(a)).toBe("ACCOUNTING_PENDING");
    expect(balance(a)).toMatchObject({ deductionsMinor: usd(3000), expectedMinor: 0 });
    expect(listWriteOffs(db, admin).decided.map((w) => w.state)).toEqual(["APPROVED", "REJECTED"]);
    expect(() => proposeWriteOff(db, ops, { blId: a, reason: "x" }, NOW)).toThrow(expect.objectContaining({ messageKey: "writeOffs.errors.closed" }));
  });
});
