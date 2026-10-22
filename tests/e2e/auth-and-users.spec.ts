import { expect, test, type Page } from "@playwright/test";
import tr from "../../src/i18n/tr.json";
import { E2E_ADMIN } from "./global-setup";

const OPS = { username: "ayse", displayName: "Ayşe Yılmaz", temp: "Gecici-sifre-1", final: "Kalici-sifre-1" };

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(tr.auth.login.username).fill(username);
  await page.getByLabel(tr.auth.login.password).fill(password);
  await page.getByRole("button", { name: tr.auth.login.submit }).click();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: /./ }).filter({ hasText: /Yönetici|Yılmaz/ }).first().click();
  await page.getByRole("menuitem", { name: tr.nav.logout }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test.describe.configure({ mode: "serial" });

test("anonymous users are sent to login; wrong passwords are rejected", async ({ page }) => {
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/login$/);
  await login(page, E2E_ADMIN.username, "wrong-password");
  await expect(page.getByText(tr.auth.login.invalid)).toBeVisible();
});

test("admin creates a user and the table layout is remembered", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await expect(page.getByText(`Hoş geldiniz, ${E2E_ADMIN.displayName}.`)).toBeVisible();

  await page.getByRole("link", { name: tr.nav.users }).click();
  await page.getByRole("button", { name: tr.users.new }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(tr.users.username).fill(OPS.username);
  await dialog.getByLabel(tr.users.displayName).fill(OPS.displayName);
  await dialog.getByLabel(tr.users.temporaryPassword).fill("short");
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(dialog.getByText(tr.users.errors.rolesRequired)).toBeVisible();
  await expect(dialog.getByText("Şifre en az 8 karakter olmalıdır.")).toBeVisible();

  await dialog.getByRole("checkbox").nth(1).click(); // Operasyon
  await dialog.getByLabel(tr.users.temporaryPassword).fill(OPS.temp);
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.users.toast.created)).toBeVisible();

  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(3); // header + 2 users
  // Turkish-insensitive search: "yilmaz" finds "Yılmaz".
  await page.getByLabel(tr.table.search).fill("yilmaz");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("cell", { name: OPS.displayName })).toBeVisible();
  await page.getByLabel(tr.table.search).fill("");

  // Hide a column and sort; both survive a reload because the layout is stored per user.
  await page.getByRole("button", { name: tr.table.columns }).click();
  await page.getByRole("menuitemcheckbox", { name: tr.users.createdAt }).click();
  await page.keyboard.press("Escape");
  await table.getByRole("button", { name: tr.users.username }).click();
  await table.getByRole("button", { name: tr.users.username }).click();
  await expect(table.getByRole("columnheader", { name: tr.users.username })).toHaveAttribute("aria-sort", "descending");
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(table.getByRole("columnheader", { name: tr.users.createdAt })).toHaveCount(0);
  await expect(table.getByRole("columnheader", { name: tr.users.username })).toHaveAttribute("aria-sort", "descending");
  await expect(table.getByRole("row").nth(1)).toContainText(E2E_ADMIN.username);

  // Keyboard: focus the table, move down one row, Enter opens it.
  await page.locator("div[tabindex='0']").filter({ has: table }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByLabel(tr.users.displayName)).toHaveValue(OPS.displayName);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await logout(page);
});

test("a new user must change the temporary password and cannot reach admin pages", async ({ page }) => {
  await login(page, OPS.username, OPS.temp);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByText(tr.auth.changePassword.forcedNotice)).toBeVisible();

  await page.goto("/");
  await expect(page).toHaveURL(/\/change-password$/);

  await page.getByLabel(tr.auth.changePassword.current).fill(OPS.temp);
  await page.getByLabel(tr.auth.changePassword.new, { exact: true }).fill(OPS.final);
  await page.getByLabel(tr.auth.changePassword.confirm).fill(OPS.final);
  await page.getByRole("button", { name: tr.auth.changePassword.submit }).click();
  await expect(page.getByText(`Hoş geldiniz, ${OPS.displayName}.`)).toBeVisible();

  await expect(page.getByRole("link", { name: tr.nav.users })).toHaveCount(0);
  await page.goto("/admin/users");
  await expect(page.getByText(tr.errors.forbidden)).toBeVisible();
  await logout(page);
});

test("five wrong passwords lock the account until an admin unlocks it", async ({ page }) => {
  for (let i = 0; i < 4; i++) {
    await login(page, OPS.username, "wrong-password");
    await expect(page.getByText(tr.auth.login.invalid)).toBeVisible();
  }
  await login(page, OPS.username, "wrong-password");
  await expect(page.getByText(tr.auth.login.locked)).toBeVisible();
  await login(page, OPS.username, OPS.final);
  await expect(page.getByText(tr.auth.login.locked)).toBeVisible();

  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await expect(page.getByText(`Hoş geldiniz, ${E2E_ADMIN.displayName}.`)).toBeVisible();
  await page.goto("/admin/users");
  const row = page.getByRole("row").filter({ hasText: OPS.username });
  await expect(row).toContainText(tr.users.locked);
  await row.getByRole("button", { name: tr.common.actions }).click();
  await page.getByRole("menuitem", { name: tr.users.unlock }).click();
  await expect(page.getByText(tr.users.toast.unlocked)).toBeVisible();
  await logout(page);

  await login(page, OPS.username, OPS.final);
  await expect(page.getByText(`Hoş geldiniz, ${OPS.displayName}.`)).toBeVisible();
});
