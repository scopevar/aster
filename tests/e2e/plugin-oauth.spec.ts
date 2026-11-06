import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { aesSecretBox } from "../../src/security/secret-box.js";
import { pluginOAuthFixture } from "../helpers/plugin-oauth.js";
import { newBot } from "./new-conversation.js";
import { openDesktop } from "../helpers/local-desktop.js";

test("plugin account controls complete a real OAuth round trip and expose cancellation without tokens", async ({}, info) => {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "oauth-desktop-")),
    root = join(directory, "package");
  const fixture = await pluginOAuthFixture();
  await mkdir(join(root, ".cursor-plugin"), { recursive: true });
  await writeFile(
    join(root, ".cursor-plugin/plugin.json"),
    JSON.stringify({
      name: "OAuth 验收服务",
      description: "远程工具账号",
      mcpServers: { remote: { url: fixture.url } },
    }),
  );
  const worker = await startWorker(directory, {
    daemon: { instanceId: randomUUID() },
    secretBox: aesSecretBox(randomBytes(32)),
    agent: {
      check: async () => ({ accountType: null, detail: "fixture" }),
      run: async () => ({ status: "completed", error: null }),
    },
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      args: [resolve(".")],
      colorScheme: null,
      env: {
        ...env,
        ASTER_DATA_DIR: directory,
        ASTER_DISABLE_AUTO_UPDATE: "1",
      },
    });
    const page = await app.firstWindow({ timeout: 30000 });
    await openDesktop(app);
    await app.evaluate(
      ({ BrowserWindow, nativeTheme, shell, dialog }, path) => {
        nativeTheme.themeSource = "light";
        BrowserWindow.getAllWindows()[0]?.setSize(1050, 768);
        const urls: string[] = [];
        Reflect.set(globalThis, "testOAuthUrls", urls);
        shell.openExternal = async (url) => {
          urls.push(url);
        };
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      },
      root,
    );
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("OAuth 验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await page
      .getByRole("button", { name: "管理本地插件", exact: true })
      .click();
    const market = page.getByRole("dialog", { name: "本地插件", exact: true });
    await market
      .getByRole("button", { name: "导入本地插件", exact: true })
      .click();
    const enable = market.getByRole("checkbox", { name: /启用 MCP/ });
    await enable.press("Space");
    await expect(enable).toBeChecked();
    await market.getByRole("button", { name: "确认导入", exact: true }).click();
    const account = market.getByRole("group", {
      name: "remote 账号连接",
      exact: true,
    });
    await expect(
      account.getByRole("button", { name: "连接账号", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("oauth-before.png"),
      scale: "css",
    });
    await account
      .getByRole("button", { name: "连接账号", exact: true })
      .click();
    await expect(account).toContainText("等待浏览器授权");
    await expect(
      account.getByRole("button", { name: "取消授权", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: info.outputPath("oauth-pending.png"),
      scale: "css",
    });
    const urls = z
      .array(z.string())
      .parse(
        await app.evaluate(() => Reflect.get(globalThis, "testOAuthUrls")),
      );
    expect(urls).toHaveLength(1);
    const url = urls[0];
    if (!url) throw Error("Missing authorization URL");
    await fixture.approve(url);
    await expect(account).toContainText("账号已连接");
    await page.screenshot({
      path: info.outputPath("oauth-connected-light.png"),
      scale: "css",
    });
    expect(await page.locator("body").innerText()).not.toContain(fixture.token);
    expect(await page.locator("body").innerText()).not.toContain(
      fixture.refresh,
    );
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "dark";
      BrowserWindow.getAllWindows()[0]?.setSize(800, 700);
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      account.getByRole("button", { name: "断开账号", exact: true }),
    ).toBeVisible();
    expect(
      await market.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("oauth-connected-dark-narrow.png"),
      scale: "css",
    });
    await account
      .getByRole("button", { name: "断开账号", exact: true })
      .click();
    await expect(account).toContainText("账号未连接");
    await account
      .getByRole("button", { name: "连接账号", exact: true })
      .click();
    await expect(account).toContainText("等待浏览器授权");
    await account
      .getByRole("button", { name: "取消授权", exact: true })
      .click();
    await expect(
      account.getByRole("button", { name: "连接账号", exact: true }),
    ).toBeEnabled();
  } finally {
    await app?.close();
    await worker.stop();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
