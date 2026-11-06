import { selectSetting } from "../helpers/settings-controls.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { data } from "./ipc-result.js";

test("search palette focuses after native dialog opens and returns to its source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-interaction-"));
  const worker = await startWorker(directory);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await app.firstWindow();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "搜索 Bot 和操作", exact: true })
      .click();
    const palette = page.getByRole("dialog", { name: "搜索", exact: true });
    const query = palette.getByRole("combobox", { name: "搜索", exact: true });
    await expect(query).toBeFocused();
    await query.fill("不存在的条目");
    await expect(palette.getByText("无结果", { exact: true })).toBeVisible();
    await query.press("Escape");
    await expect(
      page.getByRole("button", { name: "搜索 Bot 和操作", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(query).toBeFocused();
    await query.fill("设置：更新");
    await query.press("Enter");
    await expect(
      page.getByRole("heading", { name: "更新", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "搜索 Bot 和操作", exact: true })
      .click();
    await page.screenshot({
      path: test.info().outputPath("search-empty-account.png"),
      scale: "css",
    });
    await page.mouse.click(10, 120);
    await expect(palette).toHaveCount(0);
    await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "通用", exact: true }).click();
    const acceleration = page.getByRole("switch", {
      name: "使用硬件加速",
      exact: true,
    });
    await expect(acceleration).toBeChecked();
    await acceleration.click();
    await expect(acceleration).not.toBeChecked();
    await expect(page.getByText("已保存，下次启动界面时生效")).toBeVisible();
    await selectSetting(page, "显示时区", "UTC");
    await expect(
      page.getByRole("button", { name: /显示时区$/, exact: true }),
    ).toHaveText("UTC");
    await page.locator(".settings-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: test.info().outputPath("settings-general.png"),
      scale: "css",
    });
    await page
      .getByRole("switch", { name: "使用硬件安全密钥", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("settings-rules.png"),
      scale: "css",
    });
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    const restarted = await app.firstWindow();
    const applied = data(
      await restarted.evaluate(() => window.aster.preferences()),
    );
    expect(applied.appliedHardwareAcceleration).toBe(false);
    expect(applied.timeZone).toBe("UTC");
    const gpu = await app.evaluate(
      ({ app: host }) => host.getGPUFeatureStatus().gpu_compositing,
    );
    expect(gpu).not.toBe("enabled");
    await restarted
      .getByRole("button", { name: /^应用菜单/, exact: true })
      .click();
    await restarted
      .getByRole("menuitem", { name: "设置", exact: true })
      .click();
    await expect(
      restarted.getByRole("switch", { name: "使用硬件加速", exact: true }),
    ).not.toBeChecked();
    await expect(restarted.getByText("已保存，下次启动界面时生效")).toHaveCount(
      0,
    );
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 200,
    });
  }
});
