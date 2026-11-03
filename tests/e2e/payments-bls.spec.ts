import { expect, test, type Page } from "@playwright/test";
import tr from "../../src/i18n/tr.json";
import { E2E_ADMIN } from "./global-setup";

const DUAL = { username: "cift", displayName: "Çift Rollü", temp: "Gecici-sifre-3", final: "Kalici-sifre-3" };
const AGENCY = "Maersk Test";
const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${name}\n`) });

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(tr.auth.login.username).fill(username);
  await page.getByLabel(tr.auth.login.password).fill(password);
  await page.getByRole("button", { name: tr.auth.login.submit }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function pickAgency(page: Page) {
  await page.getByRole("combobox", { name: tr.payments.agency }).fill("maersk");
  await page.getByRole("option", { name: new RegExp(AGENCY) }).click();
}

async function pasteInto(page: Page, label: string, text: string) {
  await page.getByLabel(label).first().evaluate((el, data) => {
    const transfer = new DataTransfer();
    transfer.setData("text", data);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, text);
}

test.describe.configure({ mode: "serial" });

test("admin sets up a bank account and a dual-role user", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/lists");
  await page.getByRole("button", { name: tr.lists.addBankAccount }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(tr.lists.accountName).fill("USD Hesabı");
  await dialog.getByLabel(tr.lists.bankName).fill("Örnek Bank");
  await dialog.getByLabel(tr.lists.iban).fill("TR33 0006 1005 1978 6457 8413 27");
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(dialog.getByText(tr.lists.errors.iban)).toBeVisible();
  await dialog.getByLabel(tr.lists.iban).fill("TR33 0006 1005 1978 6457 8413 26");
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByRole("cell", { name: "TR330006100519786457841326" })).toBeVisible();

  await page.goto("/admin/users");
  await page.getByRole("button", { name: tr.users.new }).click();
  const userDialog = page.getByRole("dialog");
  await userDialog.getByLabel(tr.users.username).fill(DUAL.username);
  await userDialog.getByLabel(tr.users.displayName).fill(DUAL.displayName);
  await userDialog.getByRole("checkbox").nth(0).click(); // Muhasebe
  await userDialog.getByRole("checkbox").nth(1).click(); // Operasyon
  await userDialog.getByLabel(tr.users.temporaryPassword).fill(DUAL.temp);
  await userDialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.users.toast.created)).toBeVisible();
});

test("a dual-role user records payments and continues straight to the B/L", async ({ page }) => {
  await login(page, DUAL.username, DUAL.temp);
  await page.getByLabel(tr.auth.changePassword.current).fill(DUAL.temp);
  await page.getByLabel(tr.auth.changePassword.new, { exact: true }).fill(DUAL.final);
  await page.getByLabel(tr.auth.changePassword.confirm).fill(DUAL.final);
  await page.getByRole("button", { name: tr.auth.changePassword.submit }).click();
  await expect(page.getByText(`Hoş geldiniz, ${DUAL.displayName}.`)).toBeVisible();

  // Operations part of the role: an agency with a B/L number pattern.
  await page.goto("/agencies");
  await page.getByRole("button", { name: tr.agencies.new }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel(tr.agencies.name).fill(AGENCY);
  await panel.getByLabel(tr.agencies.aliases).fill("MAERSK LINE");
  await panel.getByLabel(tr.agencies.patterns).fill(String.raw`\b2\d{8}\b`);
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.agencies.toast.created)).toBeVisible();
  await panel.getByRole("button", { name: tr.common.close, exact: true }).click();
  await expect(panel).toHaveCount(0);

  // Accountant part: a bank payment with its receipt.
  await page.getByRole("link", { name: tr.nav.accounting }).click();
  await page.getByRole("button", { name: tr.payments.save }).click();
  // The receipt is optional (it may follow later); the agency is not.
  await expect(page.getByText(tr.payments.errors.agency)).toBeVisible();
  await expect(page.getByText(tr.payments.errors.evidence)).toHaveCount(0);

  await page.getByLabel(tr.files.drop).setInputFiles(pdf("dekont-1.pdf"));
  await expect(page.getByRole("link", { name: "dekont-1.pdf" })).toBeVisible();
  await expect(page.getByText(tr.payments.parserUnknown)).toBeVisible();
  await pickAgency(page);
  await page.getByLabel(tr.payments.amount).fill("3.000,50");
  await expect(page.getByText("3.000,50 USD")).toBeVisible();
  await page.getByLabel(tr.payments.blNoHint).fill("245678901");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.saved).last()).toBeVisible();

  // Continuous flow: the B/L form is prefilled with the hint.
  await expect(page.getByText(tr.payments.continueToBl)).toBeVisible();
  await expect(page.getByLabel(tr.bls.blNo)).toHaveValue("245678901");
  // Containers are entered on the B/L detail only.
  await expect(page.getByLabel(tr.bls.containers)).toHaveCount(0);
  await page.getByRole("button", { name: tr.bls.createOne }).click();
  await expect(page.getByText("B/L oluşturuldu: 245678901")).toBeVisible();

  // Same agency, amount and date again: duplicate warning, saved after confirmation.
  await page.getByLabel(tr.files.drop).setInputFiles(pdf("dekont-2.pdf"));
  await pickAgency(page);
  await page.getByLabel(tr.payments.amount).fill("3000,50");
  await page.getByRole("button", { name: tr.payments.save }).click();
  const duplicate = page.getByRole("dialog");
  await expect(duplicate.getByText(tr.payments.duplicateText)).toBeVisible();
  await expect(duplicate.getByText(/3\.000,50 USD/)).toBeVisible();
  await duplicate.getByRole("button", { name: tr.payments.duplicateConfirm }).click();
  await expect(page.getByText(tr.payments.saved).last()).toBeVisible();
  await page.getByRole("button", { name: tr.payments.newTitle }).click();

  // Bulk upload into the review queue beside the form: save one, discard the other.
  await page.getByLabel(tr.files.dropMany).setInputFiles([pdf("toplu-1.pdf"), pdf("toplu-2.pdf")]);
  await expect(page.getByText("2 dekont kuyruğa eklendi.")).toBeVisible();
  await expect(page.getByText("2 dekont inceleme bekliyor")).toBeVisible();
  await pickAgency(page);
  await page.getByLabel(tr.payments.amount).fill("1.500");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.saved).last()).toBeVisible();
  await page.getByRole("button", { name: tr.payments.newTitle }).click();
  await page.getByRole("button", { name: tr.payments.discard }).click();
  await expect(page.getByText(tr.payments.queueEmpty)).toBeVisible();
});

test("operations creates B/Ls in bulk by pasting from Excel; invalid rows stay with their errors", async ({ page }) => {
  await login(page, DUAL.username, DUAL.final);
  await page.getByRole("link", { name: tr.nav.createBls, exact: true }).click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);

  // Row 1 reuses an active B/L number. A pasted container column is ignored: containers go on the B/L detail.
  await expect(page.getByLabel(tr.bls.containers)).toHaveCount(0);
  await pasteInto(page, tr.bls.blNo, "245678901\tCSQU3054383\n299999999\tBAD1");
  await expect(page.getByLabel(tr.bls.blNo).nth(1)).toHaveValue("299999999");
  await page.getByRole("button", { name: tr.bls.saveAll.replace("{count}", "2") }).click();
  await expect(page.getByText(tr.bls.errors.blNoTaken)).toBeVisible();
  await expect(page.getByText("1 B/L oluşturuldu.")).toBeVisible();
  await expect(rows).toHaveCount(1);

  await page.getByLabel(tr.bls.blNo).first().fill("211111111");
  await page.getByRole("button", { name: tr.bls.saveAll.replace("{count}", "1") }).click();
  await expect(page.getByText("1 B/L oluşturuldu.").last()).toBeVisible();
  await expect(page.getByText(tr.bls.awaitingEmpty)).toBeVisible();

  // The global search finds a B/L, Enter opens its detail.
  await page.getByRole("combobox", { name: tr.search.label }).fill("2456789");
  await expect(page.getByRole("option").filter({ hasText: "245678901" })).toBeVisible();
  await page.getByRole("combobox", { name: tr.search.label }).press("Enter");
  await expect(page.getByRole("heading", { name: "245678901" })).toBeVisible();
  await expect(page.getByText(tr.timeline.actions.bl.create, { exact: true })).toBeVisible();
  // The edit dialog holds the B/L number and file number only.
  await page.getByRole("button", { name: tr.bls.edit }).click();
  const edit = page.getByRole("dialog", { name: tr.bls.edit });
  await expect(edit.getByLabel(tr.bls.fileNo)).toBeVisible();
  await expect(edit.getByLabel(tr.bls.containers)).toHaveCount(0);
  await edit.getByRole("button", { name: tr.common.cancel }).click();
  // Containers are added in place in the summary, with the check-digit hint.
  await page.getByRole("button", { name: tr.bls.containersEdit }).click();
  await page.getByLabel(tr.bls.containers).fill("CSQU3054384");
  await expect(page.getByText(tr.bls.checkDigitWarning.replace("{list}", "CSQU3054384"))).toBeVisible();
  await page.getByLabel(tr.bls.containers).fill("CSQU3054383");
  await page.getByLabel(tr.bls.containers).locator("..").getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.bls.updated)).toBeVisible();
  await expect(page.getByText("CSQU3054383")).toBeVisible();

  // Voiding a B/L from its detail dialog returns its payment to the work list.
  await page.getByRole("link", { name: tr.nav.allBls, exact: true }).click();
  await page.getByRole("row").filter({ hasText: "211111111" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("button", { name: tr.bls.void }).click();
  const dialog = page.getByRole("dialog", { name: tr.bls.void });
  await expect(dialog.getByRole("button", { name: tr.bls.void })).toBeDisabled();
  await dialog.getByLabel(tr.common.reasonRequired).fill("Yanlış ödemeye bağlandı");
  await dialog.getByRole("button", { name: tr.bls.void }).click();
  await expect(page.getByText(tr.bls.voided)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "211111111" })).toHaveCount(0);
  await page.getByLabel(tr.payments.showVoided).check();
  await expect(page.getByRole("row").filter({ hasText: "211111111" })).toContainText(tr.bls.voidedBadge);
  await page.getByRole("link", { name: tr.nav.createBls, exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
});

test("the accountant corrects and voids own records; receipts open from the list", async ({ page }) => {
  await login(page, DUAL.username, DUAL.final);
  await page.goto("/accounting?tab=records");
  const table = page.getByRole("table");
  await expect(table.getByRole("cell", { name: /^245678901/ })).toBeVisible();

  // The receipt link serves the stored PDF.
  const href = await table.getByRole("link", { name: tr.payments.receipt }).first().getAttribute("href");
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");

  const queued = table.getByRole("row").filter({ hasText: "1.500,00" });
  await queued.getByRole("button", { name: tr.common.actions }).click();
  await page.getByRole("menuitem", { name: tr.payments.correct }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(tr.payments.amount).fill("1.600");
  await dialog.getByRole("button", { name: tr.payments.correct }).click();
  await expect(dialog.getByText(tr.payments.errors.reason)).toBeVisible();
  await dialog.getByLabel(tr.common.reasonRequired).fill("Dekonttaki tutar 1.600");
  await dialog.getByRole("button", { name: tr.payments.correct }).click();
  await expect(page.getByText(tr.payments.corrected)).toBeVisible();
  await expect(table.getByRole("cell", { name: "1.600,00", exact: true })).toBeVisible();

  // The payment whose B/L was voided can now be voided itself.
  const awaiting = table.getByRole("row").filter({ hasText: tr.payments.statuses.awaitingBl });
  await expect(awaiting).toHaveCount(1);
  await awaiting.getByRole("button", { name: tr.common.actions }).click();
  await page.getByRole("menuitem", { name: tr.payments.void }).click();
  await page.getByRole("dialog").getByLabel(tr.common.reasonRequired).fill("Mükerrer ödeme kaydı");
  await page.getByRole("dialog").getByRole("button", { name: tr.payments.void }).click();
  await expect(page.getByText(tr.payments.voided)).toBeVisible();
  await expect(table.getByRole("row").filter({ hasText: tr.payments.statuses.awaitingBl })).toHaveCount(0);
  await page.getByLabel(tr.payments.showVoided).check();
  await expect(table.getByRole("row").filter({ hasText: tr.payments.statuses.voided })).toHaveCount(1);
});

test("a payment for an agency not in the system adds it by name, marked as missing details", async ({ page }) => {
  const name = "Yeni Hat Lojistik";
  await login(page, DUAL.username, DUAL.final);
  await page.goto("/accounting");
  await page.getByRole("combobox", { name: tr.payments.agency }).fill(name);
  await page.getByRole("option", { name: tr.agencies.addNew.replace("{name}", name) }).click();
  await expect(page.getByText(tr.payments.newAgencyHelp)).toBeVisible();
  await page.getByLabel(tr.payments.amount).fill("750");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.newAgencyAdded.replace("{name}", name))).toBeVisible();
  await expect(page.getByText(tr.payments.continueToBl)).toBeVisible();

  await page.goto("/agencies");
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByText(tr.agencies.incomplete)).toBeVisible();
});

test("an agency with units: each B/L picks one, changed later on its detail", async ({ page }) => {
  const name = "CULines Test";
  await login(page, DUAL.username, DUAL.final);
  await page.goto("/agencies");
  await page.getByRole("button", { name: tr.agencies.new }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel(tr.agencies.name).fill(name);
  await panel.locator("#agency-to").fill("genel@culines.example");
  for (const [index, unit] of ["Mersin", "İzmir"].entries()) {
    await panel.getByRole("button", { name: tr.agencies.units.add }).click();
    await panel.locator(`#unit-${index}-name`).fill(unit);
    await panel.locator(`#unit-${index}-to`).fill(`${unit === "Mersin" ? "mersin" : "izmir"}@culines.example`);
  }
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.agencies.toast.created)).toBeVisible();
  await panel.getByRole("button", { name: tr.common.close, exact: true }).click();

  // The payment continues to its B/L, which needs a unit.
  await page.goto("/accounting");
  await page.getByRole("combobox", { name: tr.payments.agency }).fill("culines");
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.getByLabel(tr.payments.amount).fill("1.200");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.continueToBl)).toBeVisible();
  await page.getByLabel(tr.bls.blNo).fill("CULU1000001");
  await expect(page.getByRole("button", { name: tr.bls.createOne })).toBeDisabled();
  await page.getByLabel(tr.bls.unit).selectOption({ label: "Mersin" });
  await page.getByRole("button", { name: tr.bls.createOne }).click();
  await expect(page.getByText("B/L oluşturuldu: CULU1000001")).toBeVisible();

  // The detail shows the unit and changes it in place.
  await page.getByRole("combobox", { name: tr.search.label }).fill("CULU1000001");
  await page.getByRole("combobox", { name: tr.search.label }).press("Enter");
  await expect(page.getByRole("heading", { name: "CULU1000001" })).toBeVisible();
  await expect(page.getByText("Mersin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: tr.bls.unitEdit }).click();
  await page.getByLabel(tr.bls.unit).selectOption({ label: "İzmir" });
  await page.getByLabel(tr.bls.unit).locator("..").getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.bls.unitSaved)).toBeVisible();
  await expect(page.getByText("İzmir", { exact: true })).toBeVisible();
  await expect(page.getByText(tr.timeline.actions.bl.setUnit, { exact: true })).toBeVisible();
});

test("a payment names its customer (a new one by name), file number and description; the B/L takes them over", async ({ page }) => {
  await login(page, DUAL.username, DUAL.final);
  await page.goto("/accounting");
  await pickAgency(page);
  await page.getByRole("combobox", { name: tr.payments.customer }).fill("Deniz İthalat");
  await page.getByRole("option", { name: tr.customers.addNew.replace("{name}", "Deniz İthalat") }).click();
  await expect(page.getByText(tr.payments.newCustomerHelp)).toBeVisible();
  await page.getByLabel(tr.payments.amount).fill("2.200");
  await page.getByLabel(tr.openingBalances.fileNo).fill("T26-77777");
  await page.getByLabel(tr.description.title).fill("Konteyner sayısı arttı");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.newCustomerAdded.replace("{name}", "Deniz İthalat"))).toBeVisible();

  // The B/L step shows what it takes over, read-only.
  await expect(page.getByText(tr.payments.continueToBl)).toBeVisible();
  await expect(page.getByText("Deniz İthalat", { exact: true })).toBeVisible();
  await expect(page.getByText("26-77777", { exact: true })).toBeVisible();
  await page.getByLabel(tr.bls.blNo).fill("233333333");
  await page.getByRole("button", { name: tr.bls.createOne }).click();
  await expect(page.getByText("B/L oluşturuldu: 233333333")).toBeVisible();

  await page.getByRole("combobox", { name: tr.search.label }).fill("233333333");
  await page.getByRole("combobox", { name: tr.search.label }).press("Enter");
  await expect(page.getByRole("heading", { name: "233333333" })).toBeVisible();
  await expect(page.getByText("Deniz İthalat", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel(tr.description.label)).toHaveValue("Konteyner sayısı arttı");
});

test("a payment with the number of an existing B/L shows, before saving, that it adds to that B/L", async ({ page }) => {
  await login(page, DUAL.username, DUAL.final);
  await page.goto("/accounting");
  await pickAgency(page);
  await page.getByLabel(tr.payments.amount).fill("500");
  await page.getByLabel(tr.payments.blNoHint).fill("245678901");
  await expect(page.getByTestId("bl-join-notice")).toHaveText("Mevcut B/L'ye ek depozito: 245678901 · 3.000,50 USD → 3.500,50 USD");
  await page.getByLabel(tr.payments.currency).selectOption("EUR");
  await expect(page.getByTestId("bl-join-notice")).toHaveText(tr.payments.errors.additionalMismatch.replace("{bl}", "245678901"));
  await page.getByLabel(tr.payments.currency).selectOption("USD");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByText(tr.payments.additionalSaved.replace("{bl}", "245678901"))).toBeVisible();
});

test("admin moves Excel records in one after another: queued receipts, carried-over agency and customer, receipt later", async ({ page }) => {
  const ob = tr.openingBalances;
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/opening-balance");
  await page.getByLabel(ob.dropReceipts).setInputFiles([pdf("eski-1.pdf"), pdf("eski-2.pdf")]);
  await expect(page.getByRole("link", { name: "eski-1.pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "eski-2.pdf", exact: true })).toBeVisible();

  await pickAgency(page);
  await page.getByRole("combobox", { name: ob.customer }).fill("Örnek İthalat");
  await page.getByRole("option", { name: tr.customers.addNew.replace("{name}", "Örnek İthalat") }).click();
  await expect(page.getByText(ob.newCustomerHelp)).toBeVisible();
  await expect(page.getByLabel(ob.pastAttempts)).toHaveValue("0");
  await page.getByLabel(ob.amount).fill("1.000");
  await page.getByLabel(tr.payments.paidAt).fill("2026-09-01");
  await page.getByLabel(tr.bls.blNo).fill("245678999");
  await page.getByRole("button", { name: ob.saveAndNext }).click();
  await expect(page.getByText(ob.saved).last()).toBeVisible();

  // The next receipt is on the form; agency and customer carried over, the rest is empty.
  await expect(page.getByRole("link", { name: "eski-2.pdf" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: tr.payments.agency })).toHaveValue(AGENCY);
  await expect(page.getByRole("combobox", { name: ob.customer })).toHaveValue("Örnek İthalat");
  await expect(page.getByLabel(ob.amount)).toHaveValue("");
  await page.getByRole("button", { name: ob.withoutReceipt }).click();
  await page.getByLabel(ob.amount).fill("2.000");
  await page.getByLabel(tr.payments.paidAt).fill("2026-09-02");
  await page.getByLabel(tr.bls.blNo).fill("245678998");
  await page.getByRole("button", { name: ob.save }).click();
  await expect(page.getByText(ob.saved).last()).toBeVisible();

  // A record with the number of a B/L entered before adds to it; that B/L keeps its own history.
  await expect(page.getByLabel(ob.amount)).toHaveValue("");
  await page.getByLabel(ob.amount).fill("500");
  await page.getByLabel(tr.payments.paidAt).fill("2026-09-05");
  await page.getByLabel(tr.bls.blNo).fill("245678999");
  await expect(page.getByTestId("bl-join-notice")).toContainText("Mevcut B/L'ye ek depozito: 245678999 · 1.000,00 USD → 1.500,00 USD");
  await expect(page.getByLabel(ob.pastAttempts)).toBeDisabled();
  await expect(page.getByRole("combobox", { name: ob.customer })).toBeDisabled();
  await page.getByRole("button", { name: ob.save }).click();
  await expect(page.getByText(ob.joined.replace("{bl}", "245678999"))).toBeVisible();

  // Saved without its receipt: the B/L detail offers to attach it.
  await page.getByRole("link", { name: "245678998" }).click();
  await expect(page.getByText(tr.payments.evidenceMissing.BANK).first()).toBeVisible();
  await page.getByLabel(tr.payments.attachEvidence.BANK).setInputFiles(pdf("sonradan.pdf"));
  await expect(page.getByText(tr.payments.evidenceAttached)).toBeVisible();
  await expect(page.getByRole("link", { name: "Dekont 245678998.pdf" }).first()).toBeVisible();
});

test("an admin keeps the customer list under General: adds, edits, and deletes one no record names", async ({ page }) => {
  const c = tr.customers;
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/lists");
  await page.getByRole("navigation", { name: tr.nav.settings }).getByRole("link", { name: tr.nav.customers }).click();
  await expect(page).toHaveURL(/\/customers$/);
  await page.getByRole("button", { name: c.new }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(c.name).fill("Beta Gıda Ltd.");
  await dialog.getByLabel(c.code).fill("2002");
  await dialog.getByLabel(c.aliases).fill("BETA\nBETAGIDA");
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(c.toast.created)).toBeVisible();
  await dialog.getByLabel(c.aliases).fill("BETA");
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(c.toast.updated)).toBeVisible();
  await dialog.getByRole("button", { name: tr.common.close, exact: true }).click();
  await expect(page.getByRole("cell", { name: "Beta Gıda Ltd." })).toBeVisible();
  // The customer added by name from the opening-balance form is on the list too.
  await expect(page.getByRole("cell", { name: "Örnek İthalat" })).toBeVisible();

  // Beta is on no record yet, so it can be deleted (with a reason); Örnek İthalat is on a B/L.
  await page.getByRole("cell", { name: "Örnek İthalat" }).click();
  await dialog.getByRole("button", { name: tr.recordDelete.button }).click();
  const confirm = page.getByRole("dialog", { name: /silinsin mi/ });
  await confirm.getByRole("textbox").fill("Yanlış kayıt");
  await confirm.getByRole("button", { name: tr.common.delete }).click();
  await expect(page.getByText(/Bu müşteri kayıtlarda kullanılıyor \(\d+ B\/L\)/)).toBeVisible();
  await confirm.getByRole("button", { name: tr.common.cancel }).click();
  await expect(confirm).toHaveCount(0);
  await dialog.getByRole("button", { name: tr.common.close, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("cell", { name: "Beta Gıda Ltd." }).click();
  await dialog.getByRole("button", { name: tr.recordDelete.button }).click();
  await confirm.getByRole("textbox").fill("Deneme kaydı");
  await confirm.getByRole("button", { name: tr.common.delete }).click();
  await expect(page.getByText("“Beta Gıda Ltd.” silindi.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Beta Gıda Ltd." })).toHaveCount(0);
});
