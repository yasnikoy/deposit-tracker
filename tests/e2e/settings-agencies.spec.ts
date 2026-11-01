import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import tr from "../../src/i18n/tr.json";
import { E2E_ADMIN } from "./global-setup";
import { openSettingsPage } from "./helpers";

const ACC = { username: "muhasebe", displayName: "Muhasebe Kullanıcısı", temp: "Gecici-sifre-2", final: "Kalici-sifre-2" };

async function login(page: Page, username: string, password: string, displayName: string) {
  await page.goto("/login");
  await page.getByLabel(tr.auth.login.username).fill(username);
  await page.getByLabel(tr.auth.login.password).fill(password);
  await page.getByRole("button", { name: tr.auth.login.submit }).click();
  await expect(page.getByText(`Hoş geldiniz, ${displayName}.`)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("admin changes a setting with a reason; invalid values cannot be saved", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password, E2E_ADMIN.displayName);
  await openSettingsPage(page, tr.nav.appSettings);

  const durations = page.locator("#durations");
  await durations.getByLabel(tr.settings.keys.durations.firstRequestDueDays.label).fill("10");
  await durations.getByLabel(tr.common.reasonOptional).fill("Acenteler geç iade ediyor");
  await durations.getByRole("button", { name: tr.settings.save }).click();
  await expect(page.getByText("1 ayar kaydedildi.")).toBeVisible();
  await page.reload();
  await expect(durations.getByLabel(tr.settings.keys.durations.firstRequestDueDays.label)).toHaveValue("10");
  await expect(durations.getByText(`Son değişiklik: ${E2E_ADMIN.displayName}`)).toBeVisible();

  const calendar = page.locator("#calendar");
  for (const day of ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma"]) await calendar.getByLabel(day, { exact: true }).check();
  await expect(calendar.getByText(tr.settings.invalid)).toBeVisible();
  await expect(calendar.getByRole("button", { name: tr.settings.save })).toBeDisabled();
});

test("admin enters holidays in bulk and the calculator uses them", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password, E2E_ADMIN.displayName);
  await openSettingsPage(page, tr.nav.holidays);
  await page.getByRole("button", { name: tr.holidays.bulk }).click();

  const dialog = page.getByRole("dialog");
  const box = dialog.getByRole("textbox", { name: tr.holidays.bulk });
  await box.fill("28.10.2026;Cumhuriyet Bayramı arifesi;Yarım\n29.10.2026;Cumhuriyet Bayramı\n30.02.2026;Yok");
  await expect(dialog.getByText(`satır 3: ${tr.holidays.errors.date}`)).toBeVisible();
  await expect(dialog.getByRole("button", { name: tr.holidays.saveAll })).toBeDisabled();
  await box.fill("28.10.2026;Cumhuriyet Bayramı arifesi;Yarım\n29.10.2026;Cumhuriyet Bayramı");
  await dialog.getByRole("button", { name: tr.holidays.saveAll }).click();
  await expect(page.getByText("2 tatil eklendi, 0 güncellendi.")).toBeVisible();

  await page.getByLabel(tr.holidays.year).selectOption("2026");
  await expect(page.getByRole("cell", { name: "Cumhuriyet Bayramı", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: tr.holidays.kinds.HALF })).toBeVisible();

  await page.getByLabel(tr.holidays.calculator.start).fill("2026-10-22");
  await page.getByLabel(tr.holidays.calculator.days).fill("7");
  await expect(page.getByTestId("calc-result")).toHaveText("7 iş günü sonrası: 04.11.2026 (Çarşamba)");
});

test("operations creates an agency; patterns are tested; only admins set overrides", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password, E2E_ADMIN.displayName);

  // Give the admin the operations role too (agency cards belong to operations).
  await page.goto("/admin/users");
  await page.getByRole("row").filter({ hasText: E2E_ADMIN.username }).click();
  await page.getByRole("dialog").getByRole("checkbox").nth(1).click();
  await page.getByRole("dialog").getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.users.toast.updated)).toBeVisible();

  // And create an accountant for the read-only check below.
  await page.getByRole("button", { name: tr.users.new }).click();
  const userDialog = page.getByRole("dialog");
  await userDialog.getByLabel(tr.users.username).fill(ACC.username);
  await userDialog.getByLabel(tr.users.displayName).fill(ACC.displayName);
  await userDialog.getByRole("checkbox").nth(0).click();
  await userDialog.getByLabel(tr.users.temporaryPassword).fill(ACC.temp);
  await userDialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.users.toast.created)).toBeVisible();

  await openSettingsPage(page, tr.nav.agencies);
  await page.getByRole("button", { name: tr.agencies.new }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel(tr.agencies.name).fill("MSC Türkiye");
  await panel.getByLabel(tr.agencies.toRecipients).fill("iade@msc.example\nhatali-adres");
  await panel.getByLabel(tr.agencies.patterns).fill("MEDU\\d{7}\n(A+)+");
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(panel.getByText(`${tr.agencies.errors.email} (satır 2)`)).toBeVisible();
  await expect(panel.getByText(`${tr.agencies.errors.pattern.unsafe} (satır 2)`)).toBeVisible();

  await panel.getByLabel(tr.agencies.toRecipients).fill("iade@msc.example");
  await panel.getByLabel(tr.agencies.patterns).fill("MEDU\\d{7}");
  await panel.getByLabel(tr.agencies.patternTest).fill("DEPOZITO medu1234567 VE MEDU7654321");
  await expect(panel.getByTestId("pattern-test-result")).toHaveText("Bulunan B/L numaraları: MEDU1234567, MEDU7654321");
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.agencies.toast.created)).toBeVisible();
  // The detail stays open on the saved agency; the list behind it gets the new row.
  await expect(page.getByRole("dialog", { name: "MSC Türkiye" })).toBeVisible();

  // Overrides (admin): empty inherits; the global value reflects the earlier settings change.
  await expect(panel.getByText("Genel: 10 iş günü")).toBeVisible();
  await panel.getByLabel(tr.settings.keys.durations.firstRequestDueDays.label).fill("3");
  await panel.getByRole("button", { name: tr.agencies.saveOverrides }).click();
  await expect(page.getByText(tr.agencies.toast.overrides)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("table").getByRole("cell", { name: "MSC Türkiye" })).toBeVisible();

  // The accountant sees agencies read-only.
  await page.getByRole("button", { name: E2E_ADMIN.displayName }).click();
  await page.getByRole("menuitem", { name: tr.nav.logout }).click();
  await page.getByLabel(tr.auth.login.username).fill(ACC.username);
  await page.getByLabel(tr.auth.login.password).fill(ACC.temp);
  await page.getByRole("button", { name: tr.auth.login.submit }).click();
  await page.getByLabel(tr.auth.changePassword.current).fill(ACC.temp);
  await page.getByLabel(tr.auth.changePassword.new, { exact: true }).fill(ACC.final);
  await page.getByLabel(tr.auth.changePassword.confirm).fill(ACC.final);
  await page.getByRole("button", { name: tr.auth.changePassword.submit }).click();
  await expect(page.getByText(`Hoş geldiniz, ${ACC.displayName}.`)).toBeVisible();

  await expect(page.getByRole("navigation", { name: tr.nav.settings })).toHaveCount(0);
  await openSettingsPage(page, tr.nav.agencies);
  await expect(page.getByRole("navigation", { name: tr.nav.settings }).getByRole("link", { name: tr.nav.lists })).toHaveCount(0);
  await expect(page.getByRole("button", { name: tr.agencies.new })).toHaveCount(0);
  await page.getByRole("cell", { name: "MSC Türkiye" }).click();
  await expect(panel.getByLabel(tr.agencies.name)).toBeDisabled();
  await expect(panel.getByText(tr.agencies.overridesReadOnly)).toBeVisible();
  await expect(panel.getByText("3 iş günü")).toBeVisible();
});

test("agencies are exported to a file and imported from one, adding only new names", async ({ page }, testInfo) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password, E2E_ADMIN.displayName);
  await openSettingsPage(page, tr.nav.agencies);
  const table = page.getByRole("table");
  await table.getByRole("row", { name: /MSC Türkiye/ }).getByRole("checkbox", { name: tr.table.selectRow }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: tr.agencies.transfer.export }).click()]);
  expect(download.suggestedFilename()).toMatch(/^acenteler-\d{4}-\d{2}-\d{2}\.json$/);
  const file = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(file.agencies).toMatchObject([{ name: "MSC Türkiye", toRecipients: ["iade@msc.example"], blNumberPatterns: ["MEDU\\d{7}"] }]);

  // The same file plus an agency this installation does not have yet.
  file.agencies.push({ ...file.agencies[0], name: "Akkon Denizcilik", toRecipients: [], blNumberPatterns: ["AKK[A-Z]{2}\\d{8}"] });
  const path = testInfo.outputPath("acenteler.json");
  await writeFile(path, JSON.stringify(file));
  await page.locator('input[type="file"][accept*="json"]').setInputFiles(path);
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("1 acente eklensin mi?")).toBeVisible();
  await expect(confirm.getByText(/atlanacak: MSC Türkiye/)).toBeVisible();
  await confirm.getByRole("button", { name: tr.agencies.transfer.confirm }).click();
  await expect(page.getByText("1 acente eklendi.")).toBeVisible();
  await expect(table.getByRole("cell", { name: "Akkon Denizcilik" })).toBeVisible();
});

test("admin sees the system health and takes a backup by hand; the public probe answers", async ({ page, request }) => {
  const probe = await request.get("/api/health");
  expect(probe.ok()).toBe(true);
  expect(await probe.json()).toMatchObject({ ok: true, version: expect.any(String) });

  await login(page, E2E_ADMIN.username, E2E_ADMIN.password, E2E_ADMIN.displayName);
  await openSettingsPage(page, tr.nav.system);
  await expect(page.getByRole("heading", { name: tr.system.title })).toBeVisible();
  await page.getByRole("button", { name: tr.system.backupNow }).click();
  await expect(page.getByText(tr.system.backupDone)).toBeVisible();
  await expect(page.getByText(tr.system.backupStale)).toHaveCount(0);
});
