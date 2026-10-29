/**
 * DEVELOPMENT ONLY: plays a shipping agency for end-to-end mail tests.
 *
 * In development the app never sends (dry-run): request emails are only stored. This script
 * reads those stored requests of one test agency from the database and answers each one with
 * a real email in the same thread (In-Reply-To / References), sent over the SMTP server from
 * the email settings to our own mailbox. The app's poller then imports the answer as an agency
 * reply. The script never writes to the database and never touches the mailbox otherwise.
 *
 * Safety: refuses to run in production or live mode, answers only requests whose every
 * recipient is our own mailbox address, and sends only to that address.
 *
 * Usage: DATA_DIR=./data pnpm agency-sim "<agency name>" [--from <address>] [--interval <seconds>]
 * The default sender is our address with "+acente" (e.g. depozito+acente@firma.com); the app skips
 * messages from our own address, so the agency needs a different one. It is only the visible
 * From: the SMTP envelope uses our own login, which mail servers require.
 *
 * Scenario per request attempt (one email may cover several B/Ls of a batched agency):
 *   1st request  → an automatic acknowledgement, then "containers not yet returned"
 *   2nd request  → "approved, payment to follow", with an approval PDF
 *   3rd and later → "deduction statement attached", with a statement PDF
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import { getDb } from "@/server/db/client";
import { agencies, emails, requests, billsOfLading } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { getSecretSetting, getSetting } from "@/server/settings";

type Reply = { text: string; attachment?: { filename: string; lines: string[] } };

const env = getEnv();
if (env.NODE_ENV === "production" || env.EMAIL_MODE === "live") throw new Error("The agency simulator is for development only.");

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const agencyName = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!agencyName) throw new Error('Usage: pnpm agency-sim "<agency name>" [--from <address>] [--interval <seconds>]');
const intervalMs = Number(option("interval") ?? 15) * 1000;
const stateFile = path.join(path.dirname(env.dataDir), "agency-sim-state.json");

const db = getDb();
const mailbox = getSetting("email.fromAddress", {}, db).toLowerCase();
if (!mailbox) throw new Error("Set the sender address (email settings) first: it is the mailbox the agency answers to.");
const [local, domain] = mailbox.split("@");
const from = option("from") ?? `${local}+acente@${domain}`;
if (from.toLowerCase() === mailbox) throw new Error("The agency must send from another address than our own; the app skips our own messages.");

const agency = db
  .select()
  .from(agencies)
  .all()
  .find((a) => a.name.toLocaleLowerCase("tr") === agencyName.toLocaleLowerCase("tr"));
if (!agency) throw new Error(`Agency "${agencyName}" not found.`);
if (agency.toRecipients.length === 0 || agency.toRecipients.some((r) => r.toLowerCase() !== mailbox) || agency.ccRecipients.length > 0) {
  throw new Error(`Agency "${agency.name}" must have exactly our mailbox (${mailbox}) as recipient and no CC, so no real agency is ever involved.`);
}

// The mail server only accepts our own login as the SMTP sender; the agency address is the visible From.
const smtpUser = getSetting("email.username", {}, db);
const transport = nodemailer.createTransport({
  host: getSetting("email.smtpHost", {}, db),
  port: getSetting("email.smtpPort", {}, db),
  secure: getSetting("email.smtpSecurity", {}, db) === "tls",
  requireTLS: getSetting("email.smtpSecurity", {}, db) === "starttls",
  auth: { user: smtpUser, pass: getSecretSetting("email.password", db) },
});

const answered = new Set<number>(fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as number[]) : []);
const remember = (id: number) => {
  answered.add(id);
  fs.writeFileSync(stateFile, JSON.stringify([...answered]));
};

/** A PDF with a few lines of text, enough for the app to store and show it. */
function pdf(lines: string[]): Buffer {
  const text = lines.map((line, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${line.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function scenario(attempt: number, blNos: string[]): Reply[] {
  const list = blNos.join(", ");
  if (attempt <= 1) {
    return [
      { text: "Bu otomatik bir yanıttır. Talebiniz alınmıştır; en kısa sürede dönüş yapılacaktır." },
      { text: `Merhaba,\n\n${list} numaralı konşimento(lar)a ait konteyner(ler) henüz boş olarak teslim edilmemiştir. Teslim sonrası iade süreci başlatılacaktır.\n\nSaygılarımızla,\n${agency!.name}` },
    ];
  }
  if (attempt === 2) {
    return [
      {
        text: `Merhaba,\n\n${list} için depozito iadesi onaylanmıştır; ödeme önümüzdeki günlerde hesabınıza yapılacaktır. Onay yazısı ektedir.\n\nSaygılarımızla,\n${agency!.name}`,
        attachment: { filename: "iade-onayi.pdf", lines: ["DEPOZITO IADE ONAYI", ...blNos.map((b) => `B/L ${b}: onaylandi`)] },
      },
    ];
  }
  return [
    {
      text: `Merhaba,\n\n${list} için kesinti dökümü ektedir. İade, kesinti düşüldükten sonra yapılacaktır.\n\nSaygılarımızla,\n${agency!.name}`,
      attachment: { filename: "kesinti-dokumu.pdf", lines: ["KESINTI DOKUMU", ...blNos.map((b) => `B/L ${b}: temizlik 50,00 USD`)] },
    },
  ];
}

/** The earlier email below the answer, the way a mail client quotes on reply. */
const quote = (email: typeof emails.$inferSelect) =>
  `\n\n-----Original Message-----\nFrom: ${email.fromAddress}\nSent: ${email.sentAt}\nTo: ${email.to.join("; ")}\nSubject: ${email.subject}\n\n${email.bodyText}`;

async function answer(email: typeof emails.$inferSelect): Promise<void> {
  const rows = db
    .select({ attemptNo: requests.attemptNo, blNo: billsOfLading.blNo })
    .from(requests)
    .innerJoin(billsOfLading, eq(billsOfLading.id, requests.blId))
    .where(eq(requests.emailId, email.id))
    .all();
  const attempt = Math.max(1, ...rows.map((r) => r.attemptNo));
  const blNos = rows.map((r) => r.blNo);
  const subject = /^re:/i.test(email.subject) ? email.subject : `RE: ${email.subject}`;
  for (const reply of scenario(attempt, blNos)) {
    await transport.sendMail({
      from: { name: agency!.name, address: from },
      to: mailbox,
      envelope: { from: smtpUser, to: [mailbox] },
      subject,
      text: reply.text + quote(email),
      inReplyTo: email.messageId,
      references: [...email.references, email.messageId],
      attachments: reply.attachment ? [{ filename: reply.attachment.filename, content: pdf(reply.attachment.lines), contentType: "application/pdf" }] : [],
    });
    console.log(`  sent "${reply.text.split("\n").find((l) => l.trim() && l !== "Merhaba,")?.slice(0, 60)}…"`);
  }
}

async function tick(): Promise<void> {
  const sent = db
    .select()
    .from(emails)
    .where(and(eq(emails.direction, "OUT"), eq(emails.agencyId, agency!.id), inArray(emails.sendStatus, ["SENT"])))
    .orderBy(asc(emails.id))
    .all()
    .filter((e) => !answered.has(e.id) && e.to.length > 0 && e.to.every((r) => r.toLowerCase() === mailbox));
  for (const email of sent) {
    console.log(`${new Date().toLocaleTimeString("tr-TR")} answering "${email.subject}" (email ${email.id})`);
    await answer(email);
    remember(email.id);
  }
}

async function main(): Promise<never> {
  console.log(`Agency simulator: "${agency!.name}" answers requests sent to ${mailbox}, from ${from}; checking every ${intervalMs / 1000} s. Ctrl+C stops.`);
  await transport.verify();
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error("send failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
