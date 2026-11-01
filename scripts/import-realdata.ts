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
 * Agencies listed with entries in the user's job-follow list (tests/realdata/job-follow.txt)
 * come from that list, which overrides the workbook for them: every listed deposit becomes a
 * payment with its full amount (an additional deposit when the B/L already exists) and every
 * listed refund an unallocated refund without receipt, for the user to split in the app. The
 * workbook's refund columns are ignored for these agencies (they were split by hand, partly
 * over other agencies' B/Ls).
 *
 * Every other agency comes from the workbook; each row with a remaining balance becomes:
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
import { createRefund } from "@/server/refunds";
import { parseReceipt, type ReceiptExtraction } from "@/server/receipts/parser";
import { prepareDatabase } from "@/server/startup";
import { eq } from "drizzle-orm";

const REALDATA = path.join(process.cwd(), "tests", "realdata");
const WORKBOOK = path.join(REALDATA, "30.10.2026.xlsx");
const JOB_FOLLOW = path.join(REALDATA, "job-follow.txt");
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

/**
 * Rows whose customer column is wrong (confirmed by the user), as { "<row no>": { name, code } }.
 * They hold real customer names, so they live next to the workbook in the git-ignored folder.
 */
const CUSTOMER_FIXES = path.join(REALDATA, "customer-fixes.json");
const CUSTOMER_OF_ROW: Record<number, { name: string; code: string | null }> = fs.existsSync(CUSTOMER_FIXES)
  ? JSON.parse(fs.readFileSync(CUSTOMER_FIXES, "utf8"))
  : {};

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

// ---- Job-follow list ----

/** Job-follow section heading → workbook agency name (a key of AGENCIES). */
const JOB_FOLLOW_AGENCIES: Record<string, string> = {
  Akkon: "AKKON",
  Atako: "ATAKO",
  "Cma Cgm": "CMA CGM",
  Cosco: "COSCO",
  Culines: "CULİNES",
  Freighturk: "FREIGHTURK",
  Hapag: "HAPAG",
  Kınay: "A.RIZA KANAY",
  Maersk: "MAERSK",
  Msc: "MSC",
  Ocean: "OCEAN",
  Stella: "STELLA",
  "Yang Ming": "YANG MING",
};

type FollowEntry =
  | { kind: "deposit"; agency: string; date: string; blText: string | null; amount: number | null; line: string }
  | { kind: "refund"; agency: string; date: string; amount: number; line: string };

/**
 * One entry per line: "d.mm.yyyy <B/L> [amount]" is a deposit paid that day (the amount only
 * when one B/L was paid in parts), "d.mm.yyyy <amount> usd iade" a refund received that day;
 * a line can carry both ("CHN1000164 - 5000 usd iade"). Sections without lines are left out.
 */
function readJobFollow(): FollowEntry[] {
  if (!fs.existsSync(JOB_FOLLOW)) return [];
  const entries: FollowEntry[] = [];
  let agency: string | null = null;
  for (const raw of fs.readFileSync(JOB_FOLLOW, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const dated = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(.*)$/.exec(line);
    if (!dated) {
      agency = JOB_FOLLOW_AGENCIES[line] ?? null;
      if (!agency) throw new Error(`job-follow: unknown agency heading "${line}"`);
      continue;
    }
    if (!agency) throw new Error(`job-follow: line before any agency heading: "${line}"`);
    const date = `${dated[3]}-${dated[2].padStart(2, "0")}-${dated[1].padStart(2, "0")}`;
    let rest = dated[4];
    const refund = /(\d[\d.]*)\s*usd\s+iade.*$/i.exec(rest);
    if (refund) {
      entries.push({ kind: "refund", agency, date, amount: num(refund[1]), line });
      rest = rest.slice(0, refund.index).replace(/[\s-]+$/, "");
    }
    if (!rest) continue;
    const amount = /\s(\d+)$/.exec(rest);
    const text = amount ? rest.slice(0, amount.index).trim() : rest;
    // "eski depo listesinden 3300": the old list's deposits as one sum, without a B/L number.
    const blText = /[A-Z]{2,}\d|\d{3}G\d{6}/i.test(text) ? text : null;
    entries.push({ kind: "deposit", agency, date, blText, amount: amount ? Number(amount[1]) : null, line });
  }
  return entries;
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
    const follow = readJobFollow();
    const followAgencies = new Set(follow.map((e) => e.agency));
    const all = readSheet(WORKBOOK)
      .map((r) => {
        const no = num(r["Kayıt No"]);
        const fix = CUSTOMER_OF_ROW[no];
        return {
          no,
          paidAt: typeof r["Yatırma Tarihi"] === "number" ? excelDate(r["Yatırma Tarihi"]) : null,
          customer: fix?.name ?? String(r["Müşteri Adı / Ünvanı"] ?? "").trim(),
          customerCode: fix ? fix.code : r["Müşteri Kodu"] !== null && r["Müşteri Kodu"] !== "" ? String(r["Müşteri Kodu"]) : null,
          agency: String(r["Depozito Alan Firma"] ?? "").trim(),
          dosya: String(r["Dosya No"] ?? "").trim(),
          currency: String(r["Para Birimi"] ?? "USD").trim(),
          deposit: num(r["Depozito Tutarı"]),
          refunded: num(r["İade Edilen Tutar"]),
          rest: num(r["Kalan Bakiye"]),
          description: String(r["Açıklama"] ?? ""),
        };
      })
      .sort((a, b) => (a.paidAt ?? "").localeCompare(b.paidAt ?? "") || a.no - b.no);
    // ---- Job-follow agencies: full deposits and unallocated refunds ----
    const usedRows = new Set<number>();
    const followReport = { deposits: 0, additional: 0, withReceipt: 0, depositMinor: 0, refunds: 0, refundMinor: 0, skipped: [] as string[] };
    const deposits = follow.filter((e) => e.kind === "deposit").sort((a, b) => a.date.localeCompare(b.date));
    for (const entry of deposits) {
      const label = `${entry.agency}: ${entry.line}`;
      try {
        const agency = ensureAgency(db, ops, entry.agency);
        let blNo = entry.blText ? blNumberOf(entry.blText, agency.patterns) : `ESKI-LISTE-${squash(entry.agency)}`;
        if (!blNo) throw new Error("no B/L number");
        const key = squash(blNo);
        // The workbook row of this deposit: same agency, paid within days (closest first), naming
        // the B/L (the workbook sometimes drops the line's prefix: "SHAGTEST0600") or, failing
        // that, the file number of the deposit's receipt.
        type WorkbookRow = (typeof all)[number];
        const rowWhere = (matches: (r: WorkbookRow) => boolean) =>
          all
            .filter(
              (r) =>
                !usedRows.has(r.no) &&
                r.agency === entry.agency &&
                r.paidAt !== null &&
                dayDiff(r.paidAt, entry.date) <= 5 &&
                (entry.amount === null || r.deposit === entry.amount) &&
                matches(r),
            )
            .sort((a, b) => dayDiff(a.paidAt!, entry.date) - dayDiff(b.paidAt!, entry.date))[0] ?? null;
        const namesBl = (r: WorkbookRow) => {
          const text = withoutPartSuffix(r.description);
          return squash(text).includes(key) || text.split(/[^A-Z0-9]+/).some((t) => t.length >= 8 && key.endsWith(t));
        };
        const fileOf = (r: WorkbookRow) => {
          const m = FILE_NUMBER.exec(r.description) ?? FILE_NUMBER.exec(r.dosya);
          return m ? m[1] : null;
        };
        const receiptByBl = () => receipts.find((r) => !r.used && dayDiff(r.date!, entry.date) <= 5 && squash(withoutPartSuffix(r.description ?? "")).includes(key)) ?? null;
        let row = rowWhere(entry.blText ? namesBl : (r) => /ESKİ LİSTE/i.test(r.description));
        if (!row && entry.blText) {
          const fileNumber = receiptByBl()?.fileNumber;
          if (fileNumber) row = rowWhere((r) => fileOf(r) === fileNumber);
        }
        if (row) usedRows.add(row.no);
        const fileNo = row ? fileOf(row) : null;
        const known = entry.amount ?? row?.deposit ?? null;
        const receipt =
          known !== null
            ? matchReceipt(receipts, { amountMinor: minor(known), paidAt: entry.date, blNo, fileNo })
            : receiptByBl();
        const amount = known ?? (receipt?.amountMinor ? receipt.amountMinor / 100 : null);
        if (amount === null) throw new Error("amount unknown: no workbook row and no receipt");
        // One workbook amount the bank paid in several transfers (3,000 = 2,700 + 300): one
        // payment per receipt, the later ones joining the B/L as additional deposits.
        let pieces: { amountMinor: number; receipt: Receipt | null }[] = [{ amountMinor: minor(amount), receipt }];
        if (!receipt && entry.blText) {
          const parts = receipts.filter((r) => !r.used && dayDiff(r.date!, entry.date) <= 5 && squash(withoutPartSuffix(r.description ?? "")).includes(key));
          if (parts.length > 1 && parts.reduce((sum, r) => sum + (r.amountMinor ?? 0), 0) === minor(amount)) {
            pieces = parts.map((r) => ({ amountMinor: r.amountMinor!, receipt: r }));
          }
        }
        for (const piece of pieces) {
          const pr = piece.receipt;
          if (pr?.description && entry.blText) blNo = blNumberOf(pr.description, agency.patterns) ?? blNo;
          const evidenceId = pr ? storeUpload(db, acc, { originalName: pr.file, content: pr.content, kind: "RECEIPT" }).id : null;
          if (pr) {
            pr.used = true;
            followReport.withReceipt++;
          }
          const result = createPayment(db, acc, {
            agencyId: agency.id,
            amountMinor: piece.amountMinor,
            currency: row?.currency ?? "USD",
            paidAt: pr?.date ?? entry.date,
            kind: "BANK",
            blNoHint: blNo,
            evidenceDocumentId: evidenceId,
            queueItemId: null,
            confirmDuplicate: true,
            extraction: pr ? readingOf(pr) : null,
          });
          if (result.status !== "created") throw new Error("payment not created");
          if (result.additionalTo) followReport.additional++;
          else {
            // Without a workbook row, customer and file number come from the receipt's reading.
            const customerId = row ? (row.customer ? ensureCustomer(db, admin, row.customer, row.customerCode) : null) : undefined;
            const { created, errors } = createBls(db, ops, [{ paymentId: result.id, blNo, containers: [], customerId, fileNo: row ? fileNo : undefined }]);
            if (errors.length > 0 || created.length === 0) throw new Error(`B/L not created: ${JSON.stringify(errors)}`);
            followReport.deposits++;
          }
        }
        followReport.depositMinor += minor(amount);
      } catch (error) {
        followReport.skipped.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const entry of follow.filter((e) => e.kind === "refund")) {
      try {
        const result = createRefund(db, acc, {
          agencyId: ensureAgency(db, ops, entry.agency).id,
          // The job-follow list does not say whose refund it is; the user corrects it in the app.
          customerId: ensureCustomer(db, admin, "Müşterisi belirsiz (iş takip listesi)", null),
          amountMinor: minor(entry.amount),
          currency: "USD",
          valueDate: entry.date,
          kind: "BANK",
          evidenceDocumentId: null,
          confirmDuplicate: true,
        });
        if (result.status !== "created") throw new Error("refund not created");
        followReport.refunds++;
        followReport.refundMinor += minor(entry.amount);
      } catch (error) {
        followReport.skipped.push(`${entry.agency}: ${entry.line}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ---- Workbook: open rows the job-follow list did not replace ----
    // For a job-follow agency these are other customers' deposits, which the list leaves out.
    const open = all.filter((r) => r.rest > 0 && !usedRows.has(r.no));
    const keptForFollowAgencies = open.filter((r) => followAgencies.has(r.agency));

    const report = { payments: 0, additional: 0, openingBalances: 0, withReceipt: 0, skipped: [] as string[], totalMinor: 0 };
    for (const row of open) {
      const label = `#${row.no} ${row.agency} ${row.deposit} ${row.currency}`;
      try {
        if (!row.paidAt) throw new Error("no payment date");
        const agency = ensureAgency(db, ops, row.agency);
        const customerId = row.customer ? ensureCustomer(db, admin, row.customer, row.customerCode) : null;
        const fileMatch = FILE_NUMBER.exec(row.description) ?? FILE_NUMBER.exec(row.dosya);
        const fileNo = fileMatch ? fileMatch[1] : null;
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
        `Job-follow agencies (${[...followAgencies].join(", ")}):`,
        `  new B/Ls: ${followReport.deposits}, additional deposits: ${followReport.additional}, with receipt: ${followReport.withReceipt}`,
        `  deposits: ${(followReport.depositMinor / 100).toLocaleString("tr-TR")}`,
        `  refunds (unallocated, no receipt): ${followReport.refunds}, ${(followReport.refundMinor / 100).toLocaleString("tr-TR")}`,
        `  skipped (${followReport.skipped.length}):`,
        ...followReport.skipped.map((s) => `    - ${s}`),
        `  their open workbook rows not in the list, imported from the workbook (${keptForFollowAgencies.length}):`,
        ...keptForFollowAgencies.map((r) => `    - #${r.no} ${r.agency} ${r.deposit} ${r.currency} (rest ${r.rest}) · ${r.customer} · ${r.description}`),
        `Workbook, open rows not in the job-follow list: ${open.length}`,
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
