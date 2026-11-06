import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { selectSetting } from "../helpers/settings-controls.js";
import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDesktop } from "../helpers/local-desktop.js";
import { data } from "./ipc-result.js";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const choice = page.getByRole("button", { name: /主题$/, exact: true });
  await choice.scrollIntoViewIfNeeded();
  return choice;
}

test("native appearance follows committed preferences, preserves old settings and restores on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-theme-e2e-"));
  await mkdir(join(directory, "desktop"));
  await writeFile(
    join(directory, "desktop/preferences.json"),
    JSON.stringify({
      version: 1,
      revision: 5,
      hardwareAcceleration: true,
      timeZone: "UTC",
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({
    args: [resolve(".")],
    env,
    colorScheme: null,
  });
  try {
    let page = await openDesktop(app);
    let choice = await openSettings(page);
    await expect(choice).toHaveText("浅色");
    await expect(page.locator(":root")).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByRole("button", { name: /显示时区$/, exact: true }),
    ).toHaveText("UTC");
    await selectSetting(page, "主题", "深色");
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("dark");
    await expect
      .poll(() =>
        page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
      )
      .toBe(true);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
        ),
      )
      .toBe("#060607");
    await expect(choice).toHaveText("深色");
    await expect(page.locator(":root")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: test.info().outputPath("theme-settings-dark.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "搜索会话和操作", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "搜索", exact: true })
      .fill("本地模板");
    await page.getByRole("option", { name: /本地模板 本地模板与导入/ }).click();
    await expect(
      page.getByRole("dialog", { name: "本地模板", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("theme-local-templates-dark.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "搜索会话和操作", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "搜索", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("theme-search-dark.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await app.close();
    app = await electron.launch({
      args: [resolve(".")],
      env,
      colorScheme: null,
    });
    page = await app.firstWindow();
    choice = await openSettings(page);
    await expect(choice).toHaveText("深色");
    await expect
      .poll(() =>
        page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: /显示时区$/, exact: true }),
    ).toHaveText("UTC");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(760, 550),
    );
    await expect(choice).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: test.info().outputPath("theme-settings-compact.png"),
      scale: "css",
    });
    await selectSetting(page, "主题", "跟随系统");
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system");
    const actual = await app.evaluate(
      ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
    );
    await expect
      .poll(() =>
        page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
      )
      .toBe(actual);
    // Simulates an OS theme notification only inside this isolated Electron process, never OS settings.
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect(page.locator(":root")).toHaveAttribute("data-theme", "dark");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect(page.locator(":root")).toHaveAttribute("data-theme", "light");
    await expect(choice).toHaveText("跟随系统");
    await selectSetting(page, "主题", "浅色");
    await expect(choice).toHaveText("浅色");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1050, 768),
    );
    await page.locator(".settings-content").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: test.info().outputPath("theme-settings-light.png"),
      scale: "css",
    });
    const revision = data(
      await page.evaluate(() => window.aster.preferences()),
    ).revision;
    await expect(
      page.evaluate(
        async (r) =>
          (
            await window.aster.savePreferences({
              revision: r,
              theme: "dark",
            })
          ).success
            ? "accepted"
            : "rejected",
        revision - 1,
      ),
    ).resolves.toBe("rejected");
    await expect(choice).toHaveText("浅色");
    expect(
      await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    ).toBe("light");
    expect(
      data(await page.evaluate(() => window.aster.preferences())).revision,
    ).toBe(revision);
    // A separate accepted IPC update makes the open form stale; its next edit must recover without replay.
    data(
      await page.evaluate(
        (r) => window.aster.savePreferences({ revision: r, theme: "system" }),
        revision,
      ),
    );
    await selectSetting(page, "主题", "深色");
    const preferenceError = page.locator(
      ".settings-content-inner > .error[role=alert]",
    );
    await expect(preferenceError).toContainText("设置已发生变化");
    await expect(choice).toHaveText("跟随系统");
    expect(
      await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    ).toBe("system");
    await selectSetting(page, "主题", "浅色");
    await expect(choice).toHaveText("浅色");
    await expect(preferenceError).toHaveCount(0);
    expect(
      data(await page.evaluate(() => window.aster.preferences())).revision,
    ).toBe(revision + 2);
  } finally {
    await app.close();
    if (await daemonStatus(directory)) await stopDaemon(directory);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
