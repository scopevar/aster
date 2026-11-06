import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { newBot } from "./new-conversation.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDesktop } from "../helpers/local-desktop.js";

test("shared titlebar keeps window actions available across chats and settings", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-titlebar-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] => item[1] !== undefined,
      ),
    ),
    ASTER_DATA_DIR: directory,
    ASTER_DISABLE_AUTO_UPDATE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await openDesktop(app);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "light";
      BrowserWindow.getAllWindows()[0]?.setSize(1120, 780);
    });
    const titlebar = page.getByRole("banner", { name: "应用标题栏" });
    await expect(titlebar).toBeVisible();
    await expect(
      page.getByRole("button", { name: "最小化", exact: true }),
    ).toHaveCount(1);
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("设计搭子");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.locator(".conversation-title")).toHaveText("设计搭子");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("一起把界面打磨得更舒服一点。");
    await page.screenshot({
      path: info.outputPath("titlebar-chat.png"),
      scale: "css",
    });
    const add = page.getByRole("button", { name: "添加", exact: true });
    const addMenu = page.getByRole("menu", { name: "添加", exact: true });
    await add.click();
    await expect(addMenu).toBeVisible();
    await page.screenshot({
      path: info.outputPath("sidebar-add-menu.png"),
      clip: { x: 0, y: 40, width: 440, height: 190 },
      scale: "css",
    });
    await add.click();
    await expect(addMenu).toHaveCount(0);
    await add.press("ArrowDown");
    await expect(
      addMenu.getByRole("menuitem", { name: "新建会话", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      addMenu.getByRole("menuitem", { name: "创建群聊", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(add).toBeFocused();
    await expect(addMenu).toHaveCount(0);
    await add.click();
    await page
      .getByRole("button", { name: "搜索会话和操作", exact: true })
      .click();
    await expect(addMenu).toHaveCount(0);
    const search = page.getByRole("combobox", { name: "搜索", exact: true });
    await expect(search).toBeFocused();
    await search.fill("设计搭子");
    await search.press("Enter");
    await expect(page.locator(".conversation-title")).toHaveText("设计搭子");
    await expect(
      addMenu.getByRole("menuitem", { name: "发起真人聊天", exact: true }),
    ).toHaveCount(0);
    const width = await page.evaluate(() => innerWidth);
    const corner = { x: width - 360, y: 0, width: 360, height: 140 };
    const maximize = titlebar.getByRole("button", {
      name: "最大化",
      exact: true,
    });
    const maximizeTooltip = titlebar.getByRole("tooltip", {
      name: "最大化",
      exact: true,
    });
    await maximize.hover();
    await expect(maximizeTooltip).toBeVisible();
    await page.screenshot({
      path: info.outputPath("titlebar-maximize-hover.png"),
      clip: corner,
      scale: "css",
    });
    await titlebar
      .getByRole("button", { name: "关闭窗口", exact: true })
      .hover();
    await expect(maximizeTooltip).toBeHidden();
    const closeTooltip = titlebar.getByRole("tooltip", {
      name: "关闭",
      exact: true,
    });
    await expect(closeTooltip).toBeVisible();
    const tooltipBounds = await closeTooltip.boundingBox();
    if (!tooltipBounds) throw new Error("Close tooltip has no bounds");
    expect(tooltipBounds.x + tooltipBounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath("titlebar-close-hover.png"),
      clip: corner,
      scale: "css",
    });

    await add.click();
    await addMenu
      .getByRole("menuitem", { name: "创建群聊", exact: true })
      .click();
    await expect(page.getByLabel("群聊收件人", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "最大化", exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "关闭新聊天", exact: true }).click();

    await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "设置", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "关闭窗口", exact: true }),
    ).toHaveCount(1);
    await titlebar.getByRole("button", { name: "最大化", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMaximized(),
        ),
      )
      .toBe(true);
    await titlebar.getByRole("button", { name: "最大化", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMaximized(),
        ),
      )
      .toBe(false);
    await page.screenshot({
      path: info.outputPath("titlebar-settings.png"),
      scale: "css",
    });

    await titlebar.getByRole("button", { name: "最小化", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMinimized(),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.restore(),
    );
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    await page.locator(".bot-item").filter({ hasText: "设计搭子" }).click();
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("一起把界面打磨得更舒服一点。");
    // The settings version must come through the real preload/Main metadata path.
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await page
      .getByRole("region", { name: "设置", exact: true })
      .getByRole("button", { name: "应用信息", exact: true })
      .click();
    const information = page.getByRole("main", {
      name: "应用信息",
      exact: true,
    });
    const version = await app.evaluate(({ app }) => app.getVersion());
    await expect(
      information.getByText(`本地版 · v${version}`, { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("settings-local-version.png"),
    });
    await page.keyboard.press("Escape");
    await expect(information).toHaveCount(0);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: info.outputPath("titlebar-dark.png"),
      scale: "css",
    });
    await titlebar
      .getByRole("button", { name: "关闭窗口", exact: true })
      .click();
    await expect.poll(() => app.windows().length).toBe(0);
    expect(await daemonStatus(directory)).not.toBeNull();
  } finally {
    try {
      if (await daemonStatus(directory)) await stopDaemon(directory);
    } finally {
      await app.close();
    }
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 200,
    });
  }
});
