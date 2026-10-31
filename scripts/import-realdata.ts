/**
 * DEVELOPMENT ONLY: loads the open positions of the real deposit workbook (tests/realdata, never
 * committed) into the local data folder, with the matching bank receipts attached, so the app
 * can be tried on real records. Not a migration tool: go-live migration stays manual
 * (ARCHITECTURE → Migration).
 *
 * Usage (dev server stopped): pnpm import:realdata [--reset]
 *   --reset  first clears all business records (payments, B/Ls, requests, emails, refunds,
 *            customers…) after a backup; users, settings, lists, templates and agencies stay.
 *
 * Each workbook row with a remaining balance becomes:
 *   - not refunded yet: a payment (with its receipt when one matches) and its B/L, or an
 *     additional deposit when the B/L already exists;
 *   - partly refunded: an opening balance for the remaining amount (the receipt attached).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import PizZip from "pizzip";
import { extractBlNumbers } from "@/domain/bl-number";
import type { AuthUser } from "@/server/auth/types";
import { agencyInputSchema } from "@/lib/schemas/agencies";
import { createAgency, updateAgency } from "@/server/agencies";
import { createBls } from "@/server/bls";
import { createCustomer } from "@/server/customers";
import { getDb, type Db } from "@/server/db/client";
import { agencies, customers, userRoles, users } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { storeUpload } from "@/server/files";
import { acquireInstanceLock } from "@/server/instance-lock";
import { createOpeningBalance } from "@/server/opening-balances";
import { createPayment } from "@/server/payments";
import { parseReceipt, type ReceiptExtraction } from "@/server/receipts/parser";
import { prepareDatabase } from "@/server/startup";
import { eq } from "drizzle-orm";

const REALDATA = path.join(process.cwd(), "tests", "realdata");
const WORKBOOK = path.join(REALDATA, "30.10.2026.xlsx");
const reset = process.argv.includes("--reset");

// ---- Workbook (xlsx is a zip of XML) ----

type Row = Record<string, string | number | null>;

function readSheet(file: string): Row[] {
  const zip = new PizZip(fs.readFileSync(file));
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const shared = [...zip.file("xl/sharedStrings.xml")!.asText().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const sheet = zip.file("xl/worksheets/sheet1.xml")!.asText();
  const rows = [...sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((m) => {
    const cells: Record<string, string | number | null> = {};
    for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, col, attrs, inner = ""] = c;
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
      cells[col] = attrs.includes('t="s"') && v !== undefined ? shared[Number(v)] : attrs.includes('t="inlineStr"') ? decode(inline ?? "") : v !== undefined ? (attrs.includes('t="str"') ? decode(v) : Number(v)) : null;
    }
    return cells;
  });
  const [header, ...data] = rows;
  return data
    .filter((r) => Object.values(r).some((v) => v !== null && v !== ""))
    .map((r) => Object.fromEntries(Object.entries(header).map(([col, name]) => [String(name), r[col] ?? null])));
}

/** Excel serial day → YYYY-MM-DD. */
const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === "number" ? v : v ? Number(String(v).replace(/\./g, "").replace(",", ".")) || 0 : 0);
const minor = (v: number) => Math.round(v * 100);

// ---- Agencies and customers ----

/** Workbook agency name → our agency card: bank name aliases (receipts) and B/L number patterns. */
const AGENCIES: Record<string, { name: string; aliases?: string[]; patterns?: string[] }> = {
  "YANG MING": { name: "Yang Ming", aliases: ["YANG MING"], patterns: ["YMJAM\\d{9}"] },
  MSC: { name: "MSC", aliases: ["MSC GEMİ"], patterns: ["MEDU[A-Z0-9]{8}"] },
  HAPAG: { name: "Hapag-Lloyd", aliases: ["HAPAG-LLOYD"], patterns: ["HLCU[A-Z0-9]{12}"] },
  OCEAN: { name: "Ocean Network Express", aliases: ["OCEAN NETWORK EXPRESS"], patterns: ["ONEY[A-Z0-9]{12}"] },
  "CMA CGM": { name: "CMA CGM", aliases: ["CMA CGM"], patterns: ["SHZ\\d{7}", "CHN\\d{7}", "QGD\\d{7}", "RTM\\d{7}"] },
  CULİNES: { name: "Culines", aliases: ["CULİNES"], patterns: ["CULV[A-Z0-9]{10}"] },
  STELLA: { name: "Stella", aliases: ["STELLA GEMİ"], patterns: ["\\d{3}G\\d{6}"] },
  "TUR-KON": { name: "Tur-Kon" },
  "A.RIZA KANAY": { name: "A. Rıza Kınay", patterns: ["ZGS[A-Z0-9]{12}"] },
  ATAKO: { name: "Atako", aliases: ["ATAKO"] },
  FREIGHTURK: { name: "Freighturk" },
  AKKON: { name: "Akkon", aliases: ["AKKON"], patterns: ["AKK[A-Z]{2}\\d{8}"] },
  "MLH GEMİ ACENTELİĞİ": { name: "MLH" },
  MAERSK: { name: "Maersk", aliases: ["MAERSK"] },
  "VTK LOJİSTİK": { name: "VTK Lojistik" },
  EVERGREEN: { name: "Evergreen" },
  BELSTAR: { name: "Belstar" },
  LİMAMAR: { name: "Limamar" },
  "DHL GLOBAL": { name: "DHL Global" },
  COSCO: { name: "Cosco", aliases: ["COSCO SHIPPING"], patterns: ["COSU\\d{10}"] },
};

function ensureAgency(db: Db, ops: AuthUser, workbookName: string): { id: number; patterns: string[] } {
  const card = AGENCIES[workbookName.trim()] ?? { name: workbookName.trim() };
  const existing = db.select().from(agencies).all().find((a) => a.name.toLocaleLowerCase("tr") === card.name.toLocaleLowerCase("tr"));
  const input = agencyInputSchema.parse({
    name: card.name,
    active: true,
    toRecipients: existing?.toRecipients ?? [],
    ccRecipients: existing?.ccRecipients ?? [],
    bankSenderAliases: [...new Set([...(existing?.bankSenderAliases ?? []), ...(card.aliases ?? [])])],
    blNumberPatterns: [...new Set([...(existing?.blNumberPatterns ?? []), ...(card.patterns ?? [])])],
    batchSending: existing?.batchSending ?? false,
    requestChannel: existing?.requestChannel ?? "EMAIL",
    portalUrl: existing?.portalUrl ?? "",
    notes: existing?.notes ?? "",
  });
  if (!existing) return { id: createAgency(db, ops, input), patterns: input.blNumberPatterns };
  if (JSON.stringify(input.bankSenderAliases) !== JSON.stringify(existing.bankSenderAliases) || JSON.stringify(input.blNumberPatterns) !== JSON.stringify(existing.blNumberPatterns)) {
    updateAgency(db, ops, { id: existing.id, agency: input });
  }
  return { id: existing.id, patterns: input.blNumberPatterns };
}

function ensureCustomer(db: Db, actor: AuthUser, name: string, code: string | null): number {
  const existing = db.select().from(customers).all().find((c) => c.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"));
  if (existing) return existing.id;
  const taken = code !== null && db.select().from(customers).where(eq(customers.code, code)).get();
  // The first word is how staff write the customer in transfer descriptions ("ORNEK", "BETA").
  return createCustomer(db, actor, { name, code: taken ? null : code, aliases: [name.split(/\s+/)[0]] });
}

// ---- B/L numbers and file numbers in descriptions ----

const FILE_NUMBER = /(?<![\p{L}\p{N}])T?(\d{2}-\d{4,6})(?![\p{N}])/iu;

/** "HLCUTA10000TEST6A-B-C" is one B/L, HLCUTA10000TEST6: the A-B-C suffix lists its parts. */
const withoutPartSuffix = (text: string) => text.toUpperCase().replace(/([A-Z0-9]{6,})A(?:-[B-Z])+(?![A-Z0-9])/g, "$1");

function blNumberOf(description: string, patterns: string[]): string | null {
  const text = withoutPartSuffix(description);
  const byPattern = extractBlNumbers(text, patterns);
  if (byPattern.length > 0) return byPattern[0];
  const token = text
    .split(/[^A-Z0-9]+/)
    .find((t) => t.length >= 8 && /\d/.test(t) && !/^T?\d{2}$/.test(t.slice(0, 3)) && !/^\d{2}-/.test(t));
  return token ?? null;
}

// ---- Data folder reset (dev only) ----

const BUSINESS_TABLES = [
  "notifications",
  "notes",
  "report_emails",
  "write_offs",
  "refund_allocations",
  "ledger_entries",
  "refunds",
  "replies",
  "email_match_suggestions",
  "email_bl_links",
  "email_attachments",
  "requests",
  "emails",
  "containers",
  "bills_of_lading",
  "receipt_queue",
  "deposit_payments",
  "customers",
];

function resetBusinessData(file: string, backupDir: string) {
  fs.mkdirSync(backupDir, { recursive: true });
  const raw = new Database(file);
  const backup = path.join(backupDir, `before-realdata-import-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  raw.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  raw.pragma("foreign_keys = OFF");
  raw.transaction(() => {
    for (const table of BUSINESS_TABLES) raw.prepare(`DELETE FROM "${table}"`).run();
    // Files no record points to any more (kept: standing documents and agency form templates).
    raw.prepare(
      `DELETE FROM documents WHERE id NOT IN (SELECT document_id FROM standing_documents)
         AND id NOT IN (SELECT form_template_document_id FROM agencies WHERE form_template_document_id IS NOT NULL)`,
    ).run();
    raw.prepare(`DELETE FROM jobs WHERE kind IN ('SEND_EMAIL', 'COPY_TO_SENT_FOLDER')`).run();
  })();
  raw.pragma("foreign_keys = ON");
  const problems = raw.pragma("foreign_key_check") as unknown[];
  raw.close();
  if (problems.length > 0) throw new Error(`Foreign key problems after reset: ${JSON.stringify(problems)}`);
  return backup;
}

// ---- Import ----

type Receipt = ReceiptExtraction & { file: string; content: Buffer; used: boolean };

async function readReceipts(): Promise<Receipt[]> {
  const byReference = new Map<string, Receipt>();
  for (const file of fs.readdirSync(REALDATA).filter((f) => f.toLowerCase().endsWith(".pdf")).sort()) {
    const content = fs.readFileSync(path.join(REALDATA, file));
    const parsed = await parseReceipt(content, "application/pdf");
    if (parsed.parser !== "garanti" || !parsed.bankReference) continue;
    // Copies of one receipt ("… (2).pdf") share the bank's reference.
    if (!byReference.has(parsed.bankReference)) byReference.set(parsed.bankReference, { ...parsed, file, content, used: false });
  }
  return [...byReference.values()];
}

/** The parser's reading alone, as a payment keeps it. */
const readingOf = ({ file: _file, content: _content, used: _used, ...reading }: Receipt): ReceiptExtraction => reading;

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function matchReceipt(receipts: Receipt[], row: { amountMinor: number; paidAt: string; blNo: string | null; fileNo: string | null }): Receipt | null {
  const candidates = receipts.filter(
    (r) =>
      !r.used &&
      r.amountMinor === row.amountMinor &&
      dayDiff(r.date!, row.paidAt) <= 5 &&
      ((row.blNo !== null && squash(withoutPartSuffix(r.description ?? "")).includes(squash(row.blNo))) || (row.fileNo !== null && r.fileNumber === row.fileNo)),
  );
  candidates.sort((a, b) => dayDiff(a.date!, row.paidAt) - dayDiff(b.date!, row.paidAt));
  return candidates[0] ?? null;
}

function actorWith(db: Db, role: "ACCOUNTANT" | "OPERATIONS" | "ADMIN", prefer: string[]): AuthUser {
  const holders = db
    .select({ id: users.id, username: users.username, displayName: users.displayName, active: users.active })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(eq(userRoles.role, role))
    .all()
    .filter((u) => u.active);
  const user = holders.find((u) => prefer.includes(u.username)) ?? holders[0];
  if (!user) throw new Error(`No active user with the ${role} role; create one first.`);
  const roles = db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, user.id)).all().map((r) => r.role);
  return { id: user.id, username: user.username, displayName: user.displayName, roles, active: true, mustChangePassword: false };
}

async function main() {
  const env = getEnv();
  if (process.env.NODE_ENV === "production" || env.EMAIL_MODE === "live") throw new Error("Development only: refusing to run with live email or in production.");
  if (!fs.existsSync(WORKBOOK)) throw new Error(`Workbook not found: ${WORKBOOK}`);
  // The app must not run meanwhile: its scheduler would act on half-imported records.
  const lock = acquireInstanceLock(env.dataDir);
  try {
    await prepareDatabase();
    if (reset) {
      const backup = resetBusinessData(path.join(env.dataDir, "deposit.sqlite"), path.join(env.dataDir, "backups"));
      console.log(`Backup: ${backup}\nBusiness records cleared.`);
    }
    const db = getDb();
    const acc = actorWith(db, "ACCOUNTANT", ["yasin"]);
    const ops = actorWith(db, "OPERATIONS", ["yasin"]);
    const admin = actorWith(db, "ADMIN", ["admin"]);

    const receipts = await readReceipts();
    const rows = readSheet(WORKBOOK);
    const open = rows
      .map((r) => ({
        no: num(r["Kayıt No"]),
        paidAt: typeof r["Yatırma Tarihi"] === "number" ? excelDate(r["Yatırma Tarihi"]) : null,
        customer: String(r["Müşteri Adı / Ünvanı"] ?? "").trim(),
        customerCode: r["Müşteri Kodu"] !== null && r["Müşteri Kodu"] !== "" ? String(r["Müşteri Kodu"]) : null,
        agency: String(r["Depozito Alan Firma"] ?? "").trim(),
        dosya: String(r["Dosya No"] ?? "").trim(),
        currency: String(r["Para Birimi"] ?? "USD").trim(),
        deposit: num(r["Depozito Tutarı"]),
        refunded: num(r["İade Edilen Tutar"]),
        rest: num(r["Kalan Bakiye"]),
        description: String(r["Açıklama"] ?? ""),
      }))
      .filter((r) => r.rest > 0)
      .sort((a, b) => (a.paidAt ?? "").localeCompare(b.paidAt ?? "") || a.no - b.no);

    const report = { payments: 0, additional: 0, openingBalances: 0, withReceipt: 0, skipped: [] as string[], totalMinor: 0 };
    for (const row of open) {
      const label = `#${row.no} ${row.agency} ${row.deposit} ${row.currency}`;
      try {
        if (!row.paidAt) throw new Error("no payment date");
        const agency = ensureAgency(db, ops, row.agency);
        const customerId = row.customer ? ensureCustomer(db, acc, row.customer, row.customerCode) : null;
        const fileMatch = FILE_NUMBER.exec(row.description) ?? FILE_NUMBER.exec(row.dosya);
        const fileNo = fileMatch ? `T${fileMatch[1]}` : null;
        const partial = row.refunded > 0;
        let blNo = blNumberOf(row.description, agency.patterns);
        const receipt = matchReceipt(receipts, { amountMinor: minor(row.deposit), paidAt: row.paidAt, blNo, fileNo });
        // The bank's description is the better source of the B/L number when the workbook lacks it.
        if (receipt?.description) blNo = blNumberOf(receipt.description, agency.patterns) ?? blNo;
        if (!blNo) throw new Error("no B/L number in the description and no matching receipt");
        const paidAt = receipt?.date ?? row.paidAt;
        // Uploaded by whoever records it: only the uploader may attach a file.
        const evidenceId = receipt ? storeUpload(db, partial ? admin : acc, { originalName: receipt.file, content: receipt.content, kind: "RECEIPT" }).id : null;
        if (receipt) {
          receipt.used = true;
          report.withReceipt++;
        }

        if (partial) {
          if (evidenceId === null) throw new Error(`partly refunded (${row.refunded} of ${row.deposit}) and no receipt to attach`);
          createOpeningBalance(db, admin, {
            agencyId: agency.id,
            amountMinor: minor(row.rest),
            currency: row.currency,
            paidAt,
            kind: "BANK",
            blNo,
            containers: [],
            customerId,
            fileNo,
            documentId: evidenceId,
            pastAttempts: 0,
            lastRequestOn: null,
            note: `Excel #${row.no}: depozito ${row.deposit}, iade ${row.refunded}, kalan ${row.rest} ${row.currency}`,
          } as Parameters<typeof createOpeningBalance>[2]);
          report.openingBalances++;
        } else {
          const result = createPayment(db, acc, {
            agencyId: agency.id,
            amountMinor: minor(row.deposit),
            currency: row.currency,
            paidAt,
            kind: "BANK",
            blNoHint: blNo,
            evidenceDocumentId: evidenceId,
            queueItemId: null,
            confirmDuplicate: true,
            extraction: receipt ? readingOf(receipt) : null,
          });
          if (result.status !== "created") throw new Error("payment not created");
          if (result.additionalTo) report.additional++;
          else {
            const { created, errors } = createBls(db, ops, [{ paymentId: result.id, blNo, containers: [], customerId, fileNo }]);
            if (errors.length > 0 || created.length === 0) throw new Error(`B/L not created: ${JSON.stringify(errors)}`);
            report.payments++;
          }
        }
        report.totalMinor += minor(row.rest);
      } catch (error) {
        report.skipped.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const unused = receipts.filter((r) => !r.used);
    console.log(
      [
        `Open workbook rows: ${open.length}`,
        `  new B/Ls from payments: ${report.payments}`,
        `  additional deposits on an existing B/L: ${report.additional}`,
        `  opening balances (partly refunded): ${report.openingBalances}`,
        `  with the bank receipt attached: ${report.withReceipt}`,
        `  open amount imported: ${(report.totalMinor / 100).toLocaleString("tr-TR")}`,
        `Skipped rows (${report.skipped.length}):`,
        ...report.skipped.map((s) => `  - ${s}`),
        `Receipts not used (${unused.length}, their rows are closed or missing in the workbook):`,
        ...unused.map((r) => `  - ${r.file}: ${r.date} ${(r.amountMinor ?? 0) / 100} ${r.currency} · ${r.description}`),
      ].join("\n"),
    );
  } finally {
    lock.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
