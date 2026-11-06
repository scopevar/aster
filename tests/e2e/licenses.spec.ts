import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";

// The Renderer server cannot cover Electron's file protocol or CSP. Exercise the
// built static artifact in the sandboxed Electron page without a new IPC method.
test("settings load bundled license text through Electron's local file protocol", async ({
  desktop,
}) => {
  const app = await desktop.launch();
  const page = await openDesktop(app);
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("region", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "应用信息", exact: true }).click();
  const panel = settings.getByRole("main", { name: "应用信息", exact: true });
  await panel.getByRole("button", { name: "第三方许可", exact: true }).click();
  const text = panel.getByLabel("第三方许可正文");
  await expect(text).toContainText("LGPL-2.1-only");
  await expect(text).toContainText("GNU GENERAL PUBLIC LICENSE");
  await page.screenshot({
    path: test.info().outputPath("application-licenses-pointer.png"),
    animations: "disabled",
  });
  await expect(
    settings.getByRole("button", { name: "返回应用", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
