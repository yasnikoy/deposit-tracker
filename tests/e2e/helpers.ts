import { expect, type Page } from "@playwright/test";
import tr from "../../src/i18n/tr.json";
import { E2E_ADMIN } from "./global-setup";

export const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${name}\n`) });

export async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(tr.auth.login.username).fill(username);
  await page.getByLabel(tr.auth.login.password).fill(password);
  await page.getByRole("button", { name: tr.auth.login.submit }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

export type E2eUser = { username: string; displayName: string; temp: string; final: string; roles: (keyof typeof tr.roles)[] };

/** The admin creates the user; the user signs in once and replaces the temporary password. */
export async function createUser(page: Page, user: E2eUser) {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: tr.users.new }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(tr.users.username).fill(user.username);
  await dialog.getByLabel(tr.users.displayName).fill(user.displayName);
  for (const role of user.roles) await dialog.getByRole("checkbox", { name: tr.roles[role] }).click();
  await dialog.getByLabel(tr.users.temporaryPassword).fill(user.temp);
  await dialog.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.users.toast.created)).toBeVisible();

  await page.context().clearCookies();
  await login(page, user.username, user.temp);
  await page.getByLabel(tr.auth.changePassword.current).fill(user.temp);
  await page.getByLabel(tr.auth.changePassword.new, { exact: true }).fill(user.final);
  await page.getByLabel(tr.auth.changePassword.confirm).fill(user.final);
  await page.getByRole("button", { name: tr.auth.changePassword.submit }).click();
  await expect(page.getByText(`Hoş geldiniz, ${user.displayName}.`)).toBeVisible();
  await page.context().clearCookies();
}

export async function pickAgency(page: Page, search: string, name: string) {
  await page.getByRole("combobox", { name: tr.payments.agency }).fill(search);
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

/** Settings pages (admin ones included) open from the header's "Ayarlar" entry and its side menu. */
export async function openSettingsPage(page: Page, label: string) {
  await page.getByRole("banner").getByRole("link", { name: tr.nav.settings, exact: true }).click();
  await page.getByRole("navigation", { name: tr.nav.settings }).getByRole("link", { name: label, exact: true }).click();
}
