import fs from "node:fs";
import { expect, test } from "@playwright/test";
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
const TEMPLATE = {
  name: "hapag-form.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: makeDocx(["{agency_name} iade formu", "B/L {bl_no}: {amount} {currency}", "IBAN: {iban}"]),
};

test.describe.configure({ mode: "serial" });

test("setup: a dual-role user records a payment and its B/L", async ({ page }) => {
  await createUser(page, OPS);
  await login(page, OPS.username, OPS.final);
  await page.goto("/agencies");
  await page.getByRole("button", { name: tr.agencies.new }).click();
  const panel = page.getByRole("complementary");
  await panel.getByLabel(tr.agencies.name).fill(AGENCY);
  await panel.getByRole("button", { name: tr.common.save }).click();
  await expect(page.getByText(tr.agencies.toast.created)).toBeVisible();

  await page.goto("/accounting");
  await page.getByLabel(tr.files.drop).setInputFiles(pdf("hapag-dekont.pdf"));
  await expect(page.getByRole("link", { name: "hapag-dekont.pdf" })).toBeVisible();
  await pickAgency(page, "hapag", AGENCY);
  await page.getByLabel(tr.payments.amount).fill("2.500");
  await page.getByRole("button", { name: tr.payments.save }).click();
  await expect(page.getByLabel(tr.bls.blNo)).toBeVisible();
  await page.getByLabel(tr.bls.blNo).fill(BL_NO);
  await page.getByRole("button", { name: tr.bls.createOne }).click();
  await expect(page.getByText(`B/L oluşturuldu: ${BL_NO}`)).toBeVisible();
});

test("an admin uploads the agency form template; unknown placeholders are refused", async ({ page }) => {
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await page.goto("/agencies");
  await page.getByRole("row").filter({ hasText: AGENCY }).click();
  const panel = page.getByRole("complementary");
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
  await expect(page.getByRole("link", { name: "imzali-form.pdf" }).first()).toBeVisible();
  await expect(page.getByText(tr.timeline.actions.form.upload)).toBeVisible();
});
