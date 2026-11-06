import { expect, type ElectronApplication } from "@playwright/test";
export async function openDesktop(app: ElectronApplication) {
  const page = await app.firstWindow();
  await expect(page.locator(".main-page")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "登录 Aster", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.aster.snapshot({})).success),
    )
    .toBe(true);
  return page;
}
