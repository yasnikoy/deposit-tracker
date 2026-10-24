import { agencyInputSchema, type AgencyInput, type AgencyOverrides } from "@/lib/schemas/agencies";
import { createAgency } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { createBls } from "@/server/bls";
import type { Db } from "@/server/db/client";
import { storeUpload } from "@/server/files";
import { createPayment } from "@/server/payments";

export const PDF = Buffer.from("%PDF-1.4\n% test receipt\n");

export const NO_OVERRIDES: AgencyOverrides = {
  "durations.firstRequestDueDays": null,
  "durations.upcomingDays": null,
  "durations.followUpDays": null,
  "durations.statementRequestDays": null,
  "durations.statementFollowUpDays": null,
};

export function makeAgency(db: Db, ops: AuthUser, name: string, overrides: Partial<AgencyInput> = {}): number {
  return createAgency(
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
      ...overrides,
    }),
  );
}

/** A bank payment (by the accountant) and its B/L (by operations). */
export function makeBl(
  db: Db,
  users: { acc: AuthUser; ops: AuthUser },
  input: { agencyId: number; blNo: string; amountMinor: number; paidAt: string; currency?: string; containers?: string[] },
  now: Date,
): { paymentId: number; blId: number } {
  const result = createPayment(
    db,
    users.acc,
    {
      agencyId: input.agencyId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "USD",
      paidAt: input.paidAt,
      kind: "BANK",
      blNoHint: null,
      evidenceDocumentId: storeUpload(db, users.acc, { originalName: "dekont.pdf", content: PDF, kind: "RECEIPT" }, now).id,
      queueItemId: null,
      confirmDuplicate: true,
    },
    now,
  );
  if (result.status !== "created") throw new Error("payment not created");
  const created = createBls(db, users.ops, [{ paymentId: result.id, blNo: input.blNo, containers: input.containers ?? [] }], now).created[0];
  if (!created) throw new Error("B/L not created");
  return { paymentId: result.id, blId: created.blId };
}
