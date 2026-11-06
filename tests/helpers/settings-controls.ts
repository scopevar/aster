import type { Page } from "@playwright/test";

export async function selectSetting(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label + "$") }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
