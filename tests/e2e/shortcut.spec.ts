import { _electron as electron, type Page } from "@playwright/test";
import { test, expect } from "../helpers/desktop-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDesktop } from "../helpers/local-desktop.js";

async function settings(page: Page) {
  await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page
    .getByRole("region", { name: "设置", exact: true })
    .getByRole("button", { name: "快捷键", exact: true })
    .click();
  return page.getByLabel("全局快捷键设置", { exact: true });
}
test("global shortcut uses real OS ownership, preserves old bindings on conflict, retries after restart and releases on exit", async ({
  desktop,
}, info) => {
  const holderDirectory = await mkdtemp(
    join(tmpdir(), "aster-shortcut-holder-"),
  );
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ASTER_DATA_DIR: desktop.directory,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const holder = await electron.launch({
    args: [resolve("tests/fixtures/shortcut-holder.mjs")],
    env: { ...env, ASTER_DATA_DIR: holderDirectory },
  });
  const first = "Control+Alt+Shift+F11",
    second = "Control+Alt+Shift+F12";
  try {
    let app = await desktop.launch({ env });
    let page = await openDesktop(app);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1050, 768),
    );
    let panel = await settings(page);
    const bind = async (key: string) => {
      await panel.getByLabel("打开窗口快捷键").focus();
      await panel.getByLabel("打开窗口快捷键").press(key);
      await panel.getByRole("button", { name: "保存快捷键" }).click();
    };
    await expect(panel.getByRole("status")).toContainText("已关闭");
    const recorder = panel.getByLabel("打开窗口快捷键");
    await page.screenshot({ path: info.outputPath("shortcut-empty.png") });
    await expect(recorder).toHaveAttribute("placeholder", "点击录制快捷键");
    await expect(panel.getByRole("button", { name: "保存快捷键" })).toHaveCount(
      0,
    );
    await expect(panel.getByRole("button", { name: "关闭快捷键" })).toHaveCount(
      0,
    );
    await recorder.focus();
    await recorder.press("A");
    await expect(panel.getByRole("alert")).toContainText("Ctrl 或 Alt");
    await expect(panel.getByRole("button", { name: "保存快捷键" })).toHaveCount(
      0,
    );
    await recorder.press(first);
    await expect(
      panel.getByRole("button", { name: "保存快捷键" }),
    ).toBeEnabled();
    await page.screenshot({ path: info.outputPath("shortcut-recording.png") });
    await recorder.press("Escape");
    await expect(panel).toBeVisible();
    await expect(recorder).toHaveValue("");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(
      await app.evaluate(
        ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
        first,
      ),
    ).toBe(false);
    await bind(first);
    await expect(panel.getByRole("status")).toHaveText(
      "应用在后台时也可打开窗口；退出应用后释放。",
    );
    await expect(panel.getByRole("button", { name: "保存快捷键" })).toHaveCount(
      0,
    );
    await expect(panel.getByText("已启用", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("shortcut-active.png") });
    expect(
      await app.evaluate(
        ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
        first,
      ),
    ).toBe(true);
    expect(
      await holder.evaluate(
        ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
        first,
      ),
    ).toBe(false);
    expect(
      await holder.evaluate(
        ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
        second,
      ),
    ).toBe(true);
    await bind(second);
    await expect(panel.getByRole("alert")).toContainText("占用");
    await expect(recorder).toHaveValue("Ctrl+Alt+Shift+F12");
    await expect(
      panel.getByRole("button", { name: "保存快捷键", exact: true }),
    ).toBeEnabled();
    expect(
      await app.evaluate(
        ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
        first,
      ),
    ).toBe(true);
    await holder.evaluate(
      ({ globalShortcut }, key) => globalShortcut.unregister(key),
      second,
    );
    await panel
      .getByRole("button", { name: "保存快捷键", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(
      await app.evaluate(
        ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
        second,
      ),
    ).toBe(true);
    expect(
      await holder.evaluate(
        ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
        first,
      ),
    ).toBe(true);
    await desktop.stop();
    expect(
      await holder.evaluate(
        ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
        second,
      ),
    ).toBe(true);
    app = await desktop.launch({ env });
    page = await app.firstWindow();
    panel = await settings(page);
    await expect(panel.getByLabel("打开窗口快捷键")).toHaveValue(
      "Ctrl+Alt+Shift+F12",
    );
    await expect(panel.getByRole("status")).toContainText("占用");
    await holder.evaluate(
      ({ globalShortcut }, key) => globalShortcut.unregister(key),
      second,
    );
    await panel.getByRole("button", { name: "保存快捷键" }).click();
    await expect(panel.getByRole("status")).toHaveText(
      "应用在后台时也可打开窗口；退出应用后释放。",
    );
    await panel.getByRole("button", { name: "关闭快捷键" }).click();
    await expect(panel.getByRole("status")).toContainText("已关闭");
    expect(
      await holder.evaluate(
        ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
        second,
      ),
    ).toBe(true);
  } finally {
    await desktop.stop();
    await holder.close();
    await rm(holderDirectory, { recursive: true, force: true });
  }
});
