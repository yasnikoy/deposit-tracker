import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_DATA_DIR } from "../../playwright.config";
import tr from "../../src/i18n/tr.json";
import { docxText, makeDocx } from "../support/docx";
import { createUser, login, pdf, pickAgency, type E2eUser } from "./helpers";
import { E2E_ADMIN } from "./global-setup";

const OPS: E2eUser = {
  username: "talep-ops",
  displayName: "Talep Operasyon",
  temp: "Gecici-sifre-7",
  final: "Kalici-sifre-7",
  roles: ["ACCOUNTANT", "OPERATIONS"],
};
const AGENCY = "Hapag Talep";
const BL_NO = "HLCU7000001";
const PORTAL_AGENCY = "Portal Acente";
const PORTAL_BL_NO = "PRTL7000002";
const TEMPLATE = {
  name: "hapag-form.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: makeDocx(["{agency_name} iade formu", "B/L {bl_no}: {amount} {currency}", "IBAN: {iban}"]),
};

test.describe.configure({ mode: "serial" });

/** A business date some days back in Istanbul, so the B/L is already due. */
function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(date);
}

async function createAgency(page: Page, name: string, portalUrl?: string) {
  await page.goto("/agencies");
  await page.getByRole("button", { name: tr.agencies.new }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel(tr.agencies.name).fill(name);
  await panel.getByLabel(tr.agencies.toRecipients).fill("iade@example.com");
  if (portalUrl) {
    await panel.getByLabel(tr.agencies.channel).selectOption("PORTAL");
    await panel.getByLabel(tr.agencies.portalUrl).fill(portalUrl);
  }
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.agencies.toast.created)).toBeVisible();
}

async function createPaymentAndBl(page: Page, agency: { search: string; name: string }, blNo: string, amount: string) {
  await page.goto("/accounting");
  await page.getByLabel(tr.files.drop).setInputFiles(pdf(`${blNo}-dekont.pdf`));
  await expect(page.getByRole("link", { name: `${blNo}-dekont.pdf` })).toBeVisible();
  await pickAgency(page, agency.search, agency.name);
  await page.getByLabel(tr.payments.amount).fill(amount);
  await page.getByLabel(tr.payments.paidAt).fill(daysAgo(30));
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByLabel(tr.bls.blNo)).toBeVisible();
  await page.getByLabel(tr.bls.blNo).fill(blNo);
  await page.getByRole("button", { name: tr.bls.createOne }).click();
  await expect(page.getByText(`B/L oluşturuldu: ${blNo}`)).toBeVisible();
}

test("setup: a dual-role user records payments and B/Ls for an email and a portal agency", async ({ page }) => {
  await createUser(page, OPS);
  await login(page, OPS.username, OPS.final);
  await createAgency(page, AGENCY);
  await createAgency(page, PORTAL_AGENCY, "https://portal.example.com");
  await createPaymentAndBl(page, { search: "hapag", name: AGENCY }, BL_NO, "2.500");
  await createPaymentAndBl(page, { search: "portal", name: PORTAL_AGENCY }, PORTAL_BL_NO, "1.000");
});

test("an admin uploads the agency form template; unknown placeholders are refused", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/agencies");
  await page.getByRole("row").filter({ hasText: AGENCY }).click();
  const panel = page.getByRole("dialog");
  await expect(panel.getByText(tr.forms.noTemplateYet)).toBeVisible();

  const bad = { ...TEMPLATE, name: "hatali.docx", buffer: makeDocx(["{bl_no} {imza}"]) };
  await panel.getByLabel(tr.forms.uploadTemplate).setInputFiles(bad);
  await expect(panel.getByText("Şablonda tanınmayan alanlar var: {imza}")).toBeVisible();

  await panel.getByLabel(tr.forms.uploadTemplate).setInputFiles(TEMPLATE);
  await expect(page.getByText(tr.forms.templateSaved)).toBeVisible();
  await expect(panel.getByRole("link", { name: TEMPLATE.name })).toBeVisible();
});

test("operations downloads the prefilled form and uploads the signed scan", async ({ page }) => {
  await login(page, OPS.username, OPS.final);
  await page.getByRole("combobox", { name: tr.search.label }).fill(BL_NO);
  await page.getByRole("combobox", { name: tr.search.label }).press("Enter");
  await expect(page.getByRole("heading", { name: BL_NO })).toBeVisible();
  await expect(page.getByText(tr.forms.noFormYet)).toBeVisible();

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: tr.forms.download }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`İade formu ${BL_NO}.docx`);
  const text = docxText(fs.readFileSync(await download.path()));
  expect(text.slice(0, 2)).toEqual([`${AGENCY} iade formu`, `B/L ${BL_NO}: 2.500,00 USD`]);

  await page.getByLabel(tr.forms.uploadForm).setInputFiles(pdf("imzali-form.pdf"));
  await expect(page.getByText(tr.forms.formUploaded)).toBeVisible();
  // The scan is renamed after the B/L, the way agencies receive it.
  await expect(page.getByRole("link", { name: `İade formu ${BL_NO}.pdf` }).first()).toBeVisible();
  await expect(page.getByText(tr.timeline.actions.form.upload)).toBeVisible();
});

test("the due list groups B/Ls by agency; a portal request is recorded once the form is uploaded", async ({ page }) => {
  await login(page, OPS.username, OPS.final);
  await page.getByRole("link", { name: tr.nav.dueRequests }).click();
  const hapag = page.getByRole("region", { name: AGENCY });
  await expect(hapag.getByTestId(`due-row-${BL_NO}`)).toContainText(`İade formu ${BL_NO}.pdf`);
  await expect(hapag).toContainText("2.500,00 USD");

  const portalGroup = page.getByRole("region", { name: PORTAL_AGENCY });
  const row = portalGroup.getByTestId(`due-row-${PORTAL_BL_NO}`);
  await expect(row.getByRole("link", { name: tr.requests.openPortal })).toHaveAttribute("href", "https://portal.example.com");
  // Without the signed form the request cannot be recorded.
  await expect(row.getByRole("button", { name: tr.requests.recordPortal })).toBeDisabled();
  await row.getByLabel(`${tr.forms.uploadForm} – ${PORTAL_BL_NO}`).setInputFiles(pdf("portal-form.pdf"));
  await expect(page.getByText(tr.forms.formUploaded)).toBeVisible();

  await row.getByRole("button", { name: tr.requests.recordPortal }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(tr.requests.portalRef).fill("PRT-4411");
  await dialog.getByRole("button", { name: tr.requests.recordPortal }).click();
  await expect(page.getByText(tr.requests.portalRecorded)).toBeVisible();
  await expect(page.getByTestId(`due-row-${PORTAL_BL_NO}`)).toHaveCount(0);

  await page.goto("/bls");
  await expect(page.getByRole("row").filter({ hasText: PORTAL_BL_NO })).toContainText(tr.bls.statuses.REQUESTED);
});

test("an admin sees the impact of a timing change before saving it", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/settings");
  const field = page.getByLabel(tr.settings.keys.durations.firstRequestDueDays.label);
  await field.fill("60");
  await expect(page.getByRole("status").filter({ hasText: tr.impact.title })).toContainText("çıkar");
  await field.fill("7");
  await expect(page.getByRole("status").filter({ hasText: tr.impact.title })).toHaveCount(0);
});

test("an admin sets the sender address and uploads a standing document", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/settings");
  const email = page.locator("#email");
  await email.getByLabel(tr.settings.keys.email.fromAddress.label).fill("depozito@firma.example");
  await email.getByLabel(tr.settings.keys.email.password.label).fill("uygulama-sifresi");
  await email.getByRole("button", { name: tr.settings.save }).click();
  await expect(page.getByText("2 ayar kaydedildi.")).toBeVisible();
  await expect(email.getByText(tr.settings.secretSet)).toBeVisible();
  await expect(email.getByLabel(tr.settings.keys.email.password.label)).toHaveValue("");

  const standing = page.locator("#standing");
  await standing.getByLabel(`${tr.standing.slots.SIGNATURE_CIRCULAR} yükleyin`).setInputFiles(pdf("imza-sirkuleri.pdf"));
  await expect(page.getByText(tr.standing.saved)).toBeVisible();
  await expect(standing.getByRole("link", { name: "imza-sirkuleri.pdf" })).toBeVisible();

  // The test email goes through the same dry-run transport.
  await page.locator("#email-test").getByLabel(tr.emailSettings.testTo).fill("it@firma.example");
  await page.getByRole("button", { name: tr.emailSettings.testSend }).click();
  await expect(page.getByText(tr.emailSettings.testDryRun)).toBeVisible();
});

test("operations previews and sends a request email; the scheduler sends it (dry-run) and the B/L is requested", async ({ page }) => {
  await login(page, OPS.username, OPS.final);
  await page.goto("/requests");
  await page.getByRole("checkbox", { name: `${tr.table.selectRow} – ${BL_NO}` }).check();
  await page.getByRole("button", { name: tr.requests.prepare }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(tr.requests.subject)).toHaveValue(`Depozito İade Talebi – B/L ${BL_NO}`);
  await expect(dialog.getByLabel(tr.requests.to)).toHaveValue("iade@example.com");
  await expect(dialog.getByLabel(tr.requests.body)).toHaveValue(/2\.500,00 USD tutarındaki depozitonun iadesini/);
  for (const name of [`İade formu ${BL_NO}.pdf`, `Dekont ${BL_NO}.pdf`, "imza-sirkuleri.pdf"]) {
    await expect(dialog.getByRole("link", { name })).toBeVisible();
  }
  await dialog.getByLabel(tr.requests.cc).fill("bilgi@firma.example");
  await dialog.getByRole("button", { name: tr.requests.send }).click();
  await expect(page.getByText(tr.requests.queued)).toBeVisible();
  await expect(page.getByTestId(`due-row-${BL_NO}`)).toHaveCount(0);

  // The in-process scheduler picks the job up within seconds.
  await expect(async () => {
    await page.goto(`/bls`);
    await expect(page.getByRole("row").filter({ hasText: BL_NO })).toContainText(tr.bls.statuses.REQUESTED, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("row").filter({ hasText: BL_NO }).click();
  await page.getByRole("link", { name: tr.bls.openDetail }).click();
  await expect(page.getByText(tr.timeline.actions.request.sent, { exact: true })).toBeVisible();
  await expect(page.locator("ol").getByText(tr.timeline.notes.dryRun)).toBeVisible();
});

/**
 * Plays the mailbox poller: stores an agency reply in the B/L's thread, as an IMAP import
 * would (there is no mailbox in e2e runs).
 */
function importReply(blNo: string, subject: string, text: string) {
  const db = new Database(path.join(E2E_DATA_DIR, "deposit.sqlite"));
  try {
    const bl = db.prepare("SELECT id, agency_id FROM bills_of_lading WHERE bl_no = ?").get(blNo) as { id: number; agency_id: number };
    const at = new Date().toISOString();
    const email = db
      .prepare(
        `INSERT INTO emails (direction, agency_id, message_id, from_address, "to", subject, body_text, received_at, created_at)
         VALUES ('IN', ?, ?, 'iade@example.com', '["depozito@firma.example"]', ?, ?, ?, ?)`,
      )
      .run(bl.agency_id, `<e2e-${blNo}-${Date.now()}@example.com>`, subject, text, at, at);
    db.prepare("INSERT INTO email_bl_links (email_id, bl_id, linked_by, created_at) VALUES (?, ?, 'THREAD', ?)").run(email.lastInsertRowid, bl.id, at);
  } finally {
    db.close();
  }
}

test("bulk reply: two agency replies get 'container not yet returned' in one confirmed action", async ({ page }) => {
  importReply(BL_NO, `RE: Depozito İade Talebi – B/L ${BL_NO}`, "Konteynerler henüz boş dönmedi.");
  importReply(PORTAL_BL_NO, "Portal başvurunuz", "Konteyner sahada.");
  await login(page, OPS.username, OPS.final);
  const repliesLink = page.getByRole("link", { name: new RegExp(tr.nav.replies) });
  await expect(repliesLink).toContainText("2");
  await repliesLink.click();

  await page.getByRole("row").filter({ hasText: "Portal başvurunuz" }).click();
  await expect(page.getByRole("dialog")).toContainText("Konteyner sahada.");
  await page.keyboard.press("Escape");

  for (const blNo of [BL_NO, PORTAL_BL_NO]) {
    await page.getByRole("row").filter({ hasText: blNo }).getByRole("checkbox").check();
  }
  const notReturned = "Konteyner henüz dönmedi";
  await page.getByRole("button", { name: notReturned }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(BL_NO);
  await expect(dialog).toContainText(PORTAL_BL_NO);
  await dialog.getByRole("button", { name: tr.replies.confirmRecord }).click();
  await expect(page.getByText("2 B/L için yanıt kaydedildi.")).toBeVisible();
  await expect(page.getByText(tr.replies.empty.TO_PROCESS)).toBeVisible();

  await page.goto("/bls");
  for (const blNo of [BL_NO, PORTAL_BL_NO]) {
    await expect(page.getByRole("row").filter({ hasText: blNo })).toContainText(tr.bls.statuses.AWAITING_RETURN);
  }
});
