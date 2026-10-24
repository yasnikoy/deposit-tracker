import "server-only";
import { and, desc, eq } from "drizzle-orm";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { blBalance } from "@/domain/balances";
import { istanbulToday } from "@/domain/business-days";
import { pickFormBankAccount, unknownPlaceholders, type FormBankAccountWarning, type FormPlaceholder } from "@/domain/forms";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import type { Db, DbOrTx } from "./db/client";
import { agencies, bankAccounts, billsOfLading, containers, documents, ledgerEntries } from "./db/schema";
import { DomainError } from "./errors";
import { attachDocument, extensionOf, readDocument, storeGeneratedDocument, type StoredDocument } from "./files";

function openTemplate(content: Buffer): Docxtemplater {
  try {
    return new Docxtemplater(new PizZip(content), {
      paragraphLoop: true,
      linebreaks: true,
      // A placeholder without a value (e.g. no bank account) stays blank, never "undefined".
      nullGetter: () => "",
    });
  } catch {
    throw new DomainError("forms.errors.invalidTemplate");
  }
}

/**
 * Tags used by a template, in order. Opening the template validates its syntax; the full
 * text joins Word's text runs, so a tag split by formatting is still read whole. Loop and
 * condition tags keep their `#` / `/` and are rejected as unknown.
 */
export function templateTags(content: Buffer): string[] {
  const text = openTemplate(content).getFullText();
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1].trim());
}

export function fillTemplate(content: Buffer, values: Record<FormPlaceholder, string>): Buffer {
  const doc = openTemplate(content);
  try {
    doc.render(values);
  } catch {
    throw new DomainError("forms.errors.invalidTemplate");
  }
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Admin uploads an agency's .docx form; unknown placeholders are reported and the template is refused. */
export function setAgencyFormTemplate(
  db: Db,
  actor: AuthUser,
  input: { agencyId: number; documentId: number },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "agency.updateFormTemplate");
  db.transaction((tx) => {
    const agency = tx.select().from(agencies).where(eq(agencies.id, input.agencyId)).get();
    if (!agency) throw new DomainError("errors.notFound");
    const doc = tx.select().from(documents).where(eq(documents.id, input.documentId)).get();
    if (!doc || doc.kind !== "FORM_TEMPLATE" || extensionOf(doc.originalName) !== "docx") {
      throw new DomainError("forms.errors.templateType");
    }
    const unknown = unknownPlaceholders(templateTags(readDocument(doc)));
    if (unknown.length > 0) throw new DomainError("forms.errors.unknownPlaceholders", { list: unknown.map((tag) => `{${tag}}`).join(", ") });

    attachDocument(tx, actor, { documentId: doc.id, kind: "FORM_TEMPLATE", ownerType: "agency", ownerId: agency.id });
    tx.update(agencies).set({ formTemplateDocumentId: doc.id, updatedAt: now.toISOString() }).where(eq(agencies.id, agency.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "agency.formTemplate",
        entityType: "agency",
        entityId: agency.id,
        before: { formTemplateDocumentId: agency.formTemplateDocumentId },
        after: { formTemplateDocumentId: doc.id, originalName: doc.originalName },
      },
      now,
    );
  });
}

export type GeneratedForm = { documentId: number; originalName: string; bankAccountWarning: FormBankAccountWarning | null };

/** The values a B/L puts into its agency's form; amounts and dates in Turkish format. */
function formValues(tx: DbOrTx, blId: number, now: Date) {
  const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, blId)).get();
  if (!bl) throw new DomainError("errors.notFound");
  if (bl.voidedAt) throw new DomainError("bls.errors.voided");
  const agency = tx.select().from(agencies).where(eq(agencies.id, bl.agencyId)).get()!;
  const numbers = tx
    .select({ containerNo: containers.containerNo })
    .from(containers)
    .where(eq(containers.blId, bl.id))
    .orderBy(containers.id)
    .all()
    .map((c) => c.containerNo);
  const entries = tx.select().from(ledgerEntries).where(eq(ledgerEntries.blId, bl.id)).all();
  const { account, warning } = pickFormBankAccount(tx.select().from(bankAccounts).all(), bl.currency);

  const values: Record<FormPlaceholder, string> = {
    agency_name: agency.name,
    bl_no: bl.blNo,
    containers: numbers.join(", "),
    container_count: String(numbers.length),
    amount: formatAmount(blBalance(entries, bl.currency).depositMinor),
    currency: bl.currency,
    paid_at: formatBusinessDate(bl.paidAt),
    bank_name: account?.bankName ?? "",
    iban: account?.iban ?? "",
    today: formatBusinessDate(istanbulToday(now)),
  };
  return { bl, agency, values, warning };
}

/** Fills the agency template for one B/L and keeps the result as a generated document on the B/L. */
export function generateBlForm(db: Db, actor: AuthUser, input: { blId: number }, now: Date = new Date()): GeneratedForm {
  const roleUsed = authorize(actor, "bl.generateForm");
  return db.transaction((tx) => {
    const { bl, agency, values, warning } = formValues(tx, input.blId, now);
    const template = agency.formTemplateDocumentId
      ? tx.select().from(documents).where(eq(documents.id, agency.formTemplateDocumentId)).get()
      : undefined;
    if (!template) throw new DomainError("forms.errors.noTemplate", { agency: agency.name });

    const doc = storeGeneratedDocument(
      tx,
      {
        kind: "GENERATED_FORM",
        originalName: `İade formu ${bl.blNo}.docx`,
        content: fillTemplate(readDocument(template), values),
        createdBy: actor.id,
        ownerType: "bill_of_lading",
        ownerId: bl.id,
      },
      now,
    );
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "form.generate",
        entityType: "bill_of_lading",
        entityId: bl.id,
        after: { documentId: doc.id, templateDocumentId: template.id, bankAccountWarning: warning },
      },
      now,
    );
    return { documentId: doc.id, originalName: doc.originalName, bankAccountWarning: warning };
  });
}

/**
 * Attaches the printed, stamped, signed and scanned form to its B/L. A B/L keeps one
 * current form: a newer upload replaces the older one for future requests.
 */
export function uploadBlForm(db: Db, actor: AuthUser, input: { blId: number; documentId: number }, now: Date = new Date()): void {
  const roleUsed = authorize(actor, "bl.uploadForm");
  db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    const previous = currentBlForm(tx, bl.id);
    const doc = attachDocument(tx, actor, { documentId: input.documentId, kind: "FORM", ownerType: "bill_of_lading", ownerId: bl.id });
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "form.upload",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: previous ? { documentId: previous.id, originalName: previous.originalName } : null,
        after: { documentId: doc.id, originalName: doc.originalName },
      },
      now,
    );
  });
}

/** The B/L's current uploaded form: its newest FORM document. */
export function currentBlForm(tx: DbOrTx, blId: number): StoredDocument | undefined {
  return tx
    .select()
    .from(documents)
    .where(and(eq(documents.ownerType, "bill_of_lading"), eq(documents.ownerId, blId), eq(documents.kind, "FORM")))
    .orderBy(desc(documents.id))
    .get();
}
