/**
 * Fills an EMPTY data folder with realistic dummy records for a walk-through test:
 * users, agencies (single email, batch, portal, misconfigured, inactive), bank accounts with
 * valid IBANs, holidays, form templates, standing documents, payments with PDF receipts,
 * B/Ls in every request state, one earlier request email so a follow-up thread exists, and
 * two imported agency emails (a reply in that thread and a possible match).
 * Dates are relative to today, so the due lists look the same whenever it runs.
 *
 * Usage: DATA_DIR=data-test KEY_FILE=test.key pnpm seed:demo [recipient-domain]
 * Refuses to run on a database that already has users. Never point it at the real data folder.
 */
import { eq } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import PizZip from "pizzip";
import { addCalendarDays, isBusinessDay, istanbulToday, type IsoDate } from "@/domain/business-days";
import { checkContainerNumber } from "@/domain/containers";
import type { Role } from "@/domain/roles";
import type { AuthUser } from "@/server/auth/types";
import { createAgency } from "@/server/agencies";
import { createBls, updateBl, voidBl } from "@/server/bls";
import { createCustomer } from "@/server/customers";
import { loadCalendar } from "@/server/calendar";
import { getDb, type Db } from "@/server/db/client";
import { emails, users } from "@/server/db/schema";
import { prepareRequestEmails } from "@/server/email/compose";
import { importMessage, parseMessage } from "@/server/email/inbound";
import { emailJobHandlers, queueRequestEmail } from "@/server/email/send";
import { mailTransport } from "@/server/email/transport";
import { getEnv } from "@/server/env";
import { storeUpload } from "@/server/files";
import { setAgencyFormTemplate, uploadBlForm } from "@/server/forms";
import { saveHolidays } from "@/server/holidays";
import { runDueJobs, type JobHandlers } from "@/server/jobs";
import { saveBankAccount } from "@/server/lists";
import { correctPayment, createPayment } from "@/server/payments";
import { updateSettings } from "@/server/settings";
import { setStandingDocument } from "@/server/standing-documents";
import { prepareDatabase } from "@/server/startup";
import { createUser } from "@/server/users";
import { agencyInputSchema, type AgencyInput } from "@/lib/schemas/agencies";

export const DEMO_PASSWORD = "Demo-sifre-2026";
const recipientDomain = process.argv[2] ?? "ornek-acente.test";

// ---- Dummy files ----

/** A one-page PDF with plain ASCII lines, enough for a browser to show it as a receipt. */
function pdf(lines: string[]): Buffer {
  const text = lines.map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) '`).join("\n");
  const content = `BT\n/F1 12 Tf\n60 780 Td\n16 TL\n${text}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A Word form template with the documented placeholders. */
function formTemplate(agencyName: string): Buffer {
  const paragraphs = [
    `${agencyName.toUpperCase()} – DEPOZİTO İADE TALEP FORMU`,
    "Tarih: {today}",
    "Acente: {agency_name}",
    "Konşimento (B/L) No: {bl_no}",
    "Konteynerler ({container_count} adet): {containers}",
    "Depozito tutarı: {amount} {currency} (ödeme tarihi {paid_at})",
    "İadenin yapılacağı banka: {bank_name}",
    "IBAN: {iban}",
    "",
    "Kaşe / İmza:",
  ];
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generate({ type: "nodebuffer" });
}

/** A Turkish IBAN with correct check digits: TR + check + 5-digit bank + 0 + 16-digit account. */
function trIban(bank: string, account: string): string {
  const bban = `${bank}0${account}`;
  const numeric = `${bban}292700`; // "TR00" moved to the end, letters as numbers (T=29, R=27)
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return `TR${String(98 - remainder).padStart(2, "0")}${bban}`;
}

/** A container number with a correct ISO 6346 check digit. */
function container(prefix: string, serial: string): string {
  for (let digit = 0; digit <= 9; digit++) {
    const candidate = `${prefix}${serial}${digit}`;
    if (checkContainerNumber(candidate).checkDigitOk) return candidate;
  }
  throw new Error(`No check digit for ${prefix}${serial}`);
}

// ---- Seeding ----

async function seed(db: Db) {
  if (db.select({ id: users.id }).from(users).limit(1).get()) {
    throw new Error("This database already has users. The demo seed only runs on an empty data folder.");
  }
  const now = new Date();
  const today = istanbulToday(now);

  const makeUser = async (username: string, displayName: string, roles: Role[]): Promise<AuthUser> => {
    const id = await createUser(db, null, { username, displayName, roles, password: DEMO_PASSWORD, mustChangePassword: false });
    return { id, username, displayName, roles, active: true, mustChangePassword: false };
  };
  const admin = await makeUser("yonetici", "Deniz Yönetici", ["ADMIN"]);
  const acc = await makeUser("muhasebe", "Ayşe Muhasebe", ["ACCOUNTANT"]);
  const ops = await makeUser("operasyon", "Mehmet Operasyon", ["OPERATIONS"]);
  const ops2 = await makeUser("operasyon2", "Zeynep Operasyon", ["OPERATIONS"]);
  await makeUser("cift", "Can Çift Rollü", ["ACCOUNTANT", "OPERATIONS"]);

  saveHolidays(
    db,
    admin,
    {
      holidays: [
        { date: "2026-10-28", name: "Cumhuriyet Bayramı arifesi", kind: "HALF" },
        { date: "2026-10-29", name: "Cumhuriyet Bayramı", kind: "FULL" },
        { date: "2027-01-01", name: "Yılbaşı", kind: "FULL" },
      ],
      reason: "Demo takvimi",
    },
    now,
  );
  const calendar = loadCalendar(db);
  /** The business date `n` business days before today. */
  const businessDaysAgo = (n: number): IsoDate => {
    let date = today;
    let left = n;
    while (left > 0) {
      date = addCalendarDays(date, -1);
      if (isBusinessDay(date, calendar)) left--;
    }
    return date;
  };

  updateSettings(
    db,
    admin,
    {
      changes: [
        { key: "email.fromAddress", value: "depozito@ornek-lojistik.test" },
        { key: "email.fromName", value: "Örnek Lojistik Depozito" },
        { key: "email.signature", value: "Saygılarımızla,\nÖrnek Lojistik A.Ş. – Depozito Takip\n+90 212 000 00 00" },
      ],
      reason: "Demo kurulumu",
    },
    now,
  );

  const accounts = [
    { name: "USD Tahsilat Hesabı", bankName: "Örnek Bankası A.Ş.", iban: trIban("00061", "0051978645784132"), currency: "USD", active: true },
    { name: "EUR Tahsilat Hesabı", bankName: "Örnek Bankası A.Ş.", iban: trIban("00061", "0051978645784133"), currency: "EUR", active: true },
    { name: "Eski USD Hesabı (kapalı)", bankName: "Kapalı Banka A.Ş.", iban: trIban("00012", "0099988877766655"), currency: "USD", active: false },
  ];
  for (const account of accounts) saveBankAccount(db, admin, { ...account, reason: null }, now);

  const agency = (input: Partial<AgencyInput> & { name: string }) =>
    createAgency(
      db,
      ops,
      agencyInputSchema.parse({
        active: true,
        toRecipients: [],
        ccRecipients: [],
        bankSenderAliases: [],
        blNumberPatterns: [],
        batchSending: false,
        requestChannel: "EMAIL",
        portalUrl: "",
        notes: "",
        ...input,
      }),
      now,
    );
  const akdeniz = agency({
    name: "Akdeniz Lines",
    toRecipients: [`akdeniz.iade@${recipientDomain}`],
    ccRecipients: [`akdeniz.muhasebe@${recipientDomain}`],
    bankSenderAliases: ["AKDENIZ LINES DENIZCILIK"],
    blNumberPatterns: [String.raw`MEDU\d{7}`],
    notes: "Her B/L için ayrı e-posta ister.",
  });
  const bogaz = agency({
    name: "Boğaz Shipping",
    toRecipients: [`bogaz.refund@${recipientDomain}`],
    bankSenderAliases: ["BOGAZ SHIPPING LTD"],
    blNumberPatterns: [String.raw`BGZU\d{7}`],
    batchSending: true,
    notes: "Toplu e-posta kabul ediyor.",
  });
  const kuzey = agency({
    name: "Kuzey Konteyner",
    toRecipients: [`kuzey.iade@${recipientDomain}`],
    blNumberPatterns: [String.raw`KZYU\d{7}`],
    requestChannel: "PORTAL",
    portalUrl: "https://portal.kuzey-konteyner.test/depozito",
    notes: "İlk talep portaldan; takipler e-posta ile.",
  });
  const ege = agency({ name: "Ege Hatları", blNumberPatterns: [String.raw`EGEU\d{7}`], notes: "Alıcı adresi ve form şablonu eksik (hata senaryosu)." });
  agency({ name: "Eski Acente", active: false, notes: "Pasif acente." });

  for (const [id, name] of [
    [akdeniz, "Akdeniz Lines"],
    [bogaz, "Boğaz Shipping"],
    [kuzey, "Kuzey Konteyner"],
  ] as const) {
    const doc = storeUpload(db, admin, { originalName: `${name} iade formu.docx`, content: formTemplate(name), kind: "FORM_TEMPLATE" }, now);
    setAgencyFormTemplate(db, admin, { agencyId: id, documentId: doc.id }, now);
  }

  // The demo B/Ls belong to one customer, whose documents go with every request.
  const customerId = createCustomer(db, admin, { name: "Örnek İthalat", code: "1001", aliases: ["ORNEK ITHALAT"] }, now);
  for (const [slot, name, title] of [
    ["SIGNATURE_CIRCULAR", "imza-sirkuleri.pdf", "IMZA SIRKULERI - Ornek Ithalat A.S."],
    ["POWER_OF_ATTORNEY", "vekaletname.pdf", "VEKALETNAME - Ornek Ithalat A.S."],
  ] as const) {
    const doc = storeUpload(db, admin, { originalName: name, content: pdf([title, "Demo belge"]), kind: "STANDING" }, now);
    setStandingDocument(db, admin, { customerId, slot, documentId: doc.id }, now);
  }

  type Spec = {
    agencyId: number;
    agencyName: string;
    blNo: string | null;
    amountMinor: number;
    currency: string;
    daysAgo: number;
    kind?: "BANK" | "OFFSET";
    containers?: string[];
    form?: boolean;
    hint?: string;
  };
  const formatted = (minor: number) => (minor / 100).toFixed(2);
  const record = (spec: Spec) => {
    const paidAt = businessDaysAgo(spec.daysAgo);
    const kind = spec.kind ?? "BANK";
    const evidence = storeUpload(
      db,
      acc,
      {
        originalName: `${kind === "BANK" ? "dekont" : "fatura"}-${spec.blNo ?? spec.hint ?? "bl-yok"}.pdf`,
        content: pdf([
          kind === "BANK" ? "ORNEK BANKASI A.S. - GIDEN HAVALE DEKONTU" : "MAHSUP FATURASI",
          `Tarih: ${paidAt}`,
          `Alici: ${spec.agencyName.toUpperCase()}`,
          `Tutar: ${formatted(spec.amountMinor)} ${spec.currency}`,
          `Aciklama: DEPOZITO ${spec.blNo ?? spec.hint ?? ""}`,
        ]),
        kind: kind === "BANK" ? "RECEIPT" : "INVOICE",
      },
      now,
    );
    const result = createPayment(
      db,
      acc,
      {
        agencyId: spec.agencyId,
        amountMinor: spec.amountMinor,
        currency: spec.currency,
        paidAt,
        kind,
        blNoHint: spec.hint ?? null,
        evidenceDocumentId: evidence.id,
        queueItemId: null,
        confirmDuplicate: true,
      },
      now,
    );
    if (result.status !== "created") throw new Error("payment not created");
    if (!spec.blNo) return { paymentId: result.id, blId: null, paidAt };
    const created = createBls(db, ops, [{ paymentId: result.id, blNo: spec.blNo, customerId }], now);
    if (created.errors.length) throw new Error(`B/L ${spec.blNo}: ${JSON.stringify(created.errors)}`);
    const blId = created.created[0].blId;
    // Containers are entered on the B/L detail, after creation.
    if (spec.containers?.length) updateBl(db, ops, { id: blId, containers: spec.containers }, now);
    if (spec.form) {
      const form = storeUpload(db, ops, { originalName: `imzali-form-${spec.blNo}.pdf`, content: pdf([`IADE TALEP FORMU - ${spec.blNo}`, "Kase / imza: (taranmis)"]), kind: "FORM" }, now);
      uploadBlForm(db, ops, { blId, documentId: form.id }, now);
    }
    return { paymentId: result.id, blId, paidAt };
  };

  const A = { agencyId: akdeniz, agencyName: "Akdeniz Lines" };
  const B = { agencyId: bogaz, agencyName: "Bogaz Shipping" };
  const K = { agencyId: kuzey, agencyName: "Kuzey Konteyner" };
  const E = { agencyId: ege, agencyName: "Ege Hatlari" };

  // Akdeniz Lines (one email per B/L)
  record({ ...A, blNo: "MEDU1000001", amountMinor: 300000, currency: "USD", daysAgo: 20, form: true, containers: [container("MSCU", "123456"), container("MSCU", "765432")] });
  const medu2 = record({ ...A, blNo: "MEDU1000002", amountMinor: 250000, currency: "USD", daysAgo: 12, containers: [container("MSCU", "200002")] });
  record({ ...A, blNo: "MEDU1000003", amountMinor: 180000, currency: "USD", daysAgo: 6, form: true, containers: [container("MSCU", "300003")] });
  const medu4 = record({ ...A, blNo: "MEDU1000004", amountMinor: 420000, currency: "USD", daysAgo: 25, form: true, containers: [container("TGHU", "400004")] });
  record({ ...A, blNo: "MEDU1000005", amountMinor: 95000, currency: "USD", daysAgo: 2, containers: [container("MSCU", "500005")] });
  const voided = record({ ...A, blNo: "MEDU1000099", amountMinor: 300000, currency: "USD", daysAgo: 9 });
  record({ ...A, blNo: null, amountMinor: 275000, currency: "USD", daysAgo: 3, hint: "MEDU1000006" });

  // Boğaz Shipping (batched emails)
  record({ ...B, blNo: "BGZU2000001", amountMinor: 300000, currency: "USD", daysAgo: 15, form: true, containers: [container("BGZU", "100001")] });
  record({ ...B, blNo: "BGZU2000002", amountMinor: 200000, currency: "USD", daysAgo: 14, form: true, containers: [container("BGZU", "100002"), container("BGZU", "100003")] });
  record({ ...B, blNo: "BGZU2000003", amountMinor: 175000, currency: "EUR", daysAgo: 13, form: true, containers: [container("BGZU", "100004")] });
  record({ ...B, blNo: "BGZU2000004", amountMinor: 220000, currency: "EUR", daysAgo: 11, kind: "OFFSET", containers: [container("BGZU", "100005")] });
  record({ ...B, blNo: null, amountMinor: 125000, currency: "EUR", daysAgo: 4 });

  // Kuzey Konteyner (portal agency: the first request is filed on the portal, its documents go by email)
  record({ ...K, blNo: "KZYU3000001", amountMinor: 500000, currency: "USD", daysAgo: 10, form: true, containers: [container("KZYU", "300001")] });
  record({ ...K, blNo: "KZYU3000002", amountMinor: 330000, currency: "USD", daysAgo: 20, form: true, containers: [container("KZYU", "300002")] });

  // Ege Hatları (misconfigured agency)
  record({ ...E, blNo: "EGEU4000001", amountMinor: 120000, currency: "USD", daysAgo: 12, form: true, containers: [container("EGEU", "400001")] });

  // A wrong B/L, voided: its payment is back in "awaiting B/L".
  voidBl(db, ops, { id: voided.blId!, reason: "Yanlış B/L numarası girildi" }, now);
  // A corrected payment: the ledger shows the compensation.
  correctPayment(
    db,
    acc,
    { id: medu2.paymentId, agencyId: akdeniz, amountMinor: 260000, currency: "USD", paidAt: medu2.paidAt, reason: "Dekont tutarı yanlış girilmişti" },
    now,
  );

  // An earlier first request for MEDU1000004, sent 7 business days ago in dry-run, so its follow-up
  // is due and replies in that thread.
  const sentOn = new Date(`${businessDaysAgo(7)}T07:30:00Z`);
  const [draft] = prepareRequestEmails(db, ops2, { blIds: [medu4.blId!] }, sentOn);
  queueRequestEmail(
    db,
    ops2,
    { blIds: [medu4.blId!], to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, documentIds: draft.attachments.map((a) => a.documentId) },
    sentOn,
  );
  await runDueJobs(db, emailJobHandlers(db, () => mailTransport(db)) as JobHandlers, () => sentOn);

  // Agency emails as the mailbox poller would import them: a reply in MEDU1000004's thread
  // (to process, past the warning), and a portal agency's email naming KZYU3000002 (possible match).
  const sentMessageId = db.select({ messageId: emails.messageId }).from(emails).where(eq(emails.direction, "OUT")).get()!.messageId;
  await importDemoEmail(db, {
    from: `Akdeniz Iade <iade@${recipientDomain}>`,
    subject: `RE: ${draft.subject}`,
    text: "Merhaba,\n\nMEDU1000004 kapsamındaki konteyner henüz boş olarak teslim edilmedi. Teslim sonrası iade süreci başlatılacaktır.\n\nSaygılarımızla",
    inReplyTo: sentMessageId,
    receivedAt: new Date(`${businessDaysAgo(2)}T08:15:00Z`),
    attachment: { filename: "konteyner-durum.pdf", content: pdf(["KONTEYNER DURUM RAPORU", "TGHU4000046: sahada"]) },
  });
  await importDemoEmail(db, {
    from: `Kuzey Operasyon <ops@${recipientDomain}>`,
    subject: "Depozito iade başvurusu KZYU3000002",
    text: "Portal başvurunuz (KZ-2026-0815) incelemeye alınmıştır.",
    receivedAt: new Date(`${businessDaysAgo(1)}T11:40:00Z`),
  });

  return { users: ["yonetici", "muhasebe", "operasyon", "operasyon2", "cift"] };
}

async function importDemoEmail(
  db: Db,
  input: { from: string; subject: string; text: string; inReplyTo?: string; receivedAt: Date; attachment?: { filename: string; content: Buffer } },
) {
  const raw = await new MailComposer({
    from: input.from,
    to: "depozito@ornek-lojistik.test",
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo,
    references: input.inReplyTo ? [input.inReplyTo] : undefined,
    date: input.receivedAt,
    attachments: input.attachment ? [input.attachment] : undefined,
  })
    .compile()
    .build();
  const parsed = await parseMessage(raw);
  db.transaction((tx) => importMessage(tx, parsed, { raw, receivedAt: input.receivedAt }, {}, input.receivedAt));
}

if (getEnv().EMAIL_MODE === "live") throw new Error("Run the demo seed in dry-run mode.");
prepareDatabase()
  .then(() => seed(getDb()))
  .then((summary) => {
    console.log(`Demo data written to ${getEnv().dataDir}`);
    console.log(`Users (password for all: ${DEMO_PASSWORD}): ${summary.users.join(", ")}`);
    console.log(`Agency recipients use the domain ${recipientDomain}`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
