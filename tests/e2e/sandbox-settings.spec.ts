import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";

test("sandbox settings persist, reject invalid proxy and diagnose real Fake-IP DNS and HTTPS in both themes", async ({
  desktop,
}, info) => {
  test.skip(
    process.env.ASTER_TEST_MICROSANDBOX !== "1" ||
      !process.env.ASTER_TEST_SANDBOX_PROXY,
    "requires a real Microsandbox host and ASTER_TEST_SANDBOX_PROXY on a Fake-IP network",
  );
  test.setTimeout(240000);
  try {
    const data = localWorkspaceDirectory(desktop.directory);
    if (process.env.ASTER_TEST_MICROSANDBOX_CACHE) {
      const runtime = join(data, "scripts", "runtime");
      await mkdir(runtime, { recursive: true });
      await cp(
        resolve(process.env.ASTER_TEST_MICROSANDBOX_CACHE),
        join(runtime, "cache"),
        { recursive: true, force: false, errorOnExist: true },
      );
    }
    if (process.env.ASTER_TEST_MICROSANDBOX_ASSETS)
      await cp(
        resolve(process.env.ASTER_TEST_MICROSANDBOX_ASSETS),
        join(data, "scripts", "assets"),
        { recursive: true },
      );
    let app = await desktop.launch({
      colorScheme: null,
    });
    let page = await openDesktop(app);
    const open = async () => {
      await page.getByRole("button", { name: /^应用菜单/ }).click();
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      await page
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: "沙箱", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "保存配置", exact: true }),
      ).toBeEnabled();
    };
    await open();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "light";
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 850);
    });
    const select = async (label: string, option: string) => {
      await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    await select("出站代理", "HTTP CONNECT");
    const proxy = page.getByRole("textbox", { name: "代理地址", exact: true });
    await proxy.fill("user:secret@127.0.0.1:7897");
    await expect(
      page.getByRole("button", { name: "保存配置", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("IP:端口");
    await proxy.fill(process.env.ASTER_TEST_SANDBOX_PROXY ?? "127.0.0.1:7897");
    await select("DNS 解析", "系统 DNS");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "已保存" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("sandbox-settings-light.png"),
      scale: "css",
    });
    await desktop.stop();
    app = await desktop.launch({
      colorScheme: null,
    });
    page = await app.firstWindow();
    await open();
    await expect(page.getByRole("button", { name: /DNS 解析$/ })).toContainText(
      "系统 DNS",
    );
    await expect(
      page.getByRole("textbox", { name: "代理地址", exact: true }),
    ).toHaveValue(process.env.ASTER_TEST_SANDBOX_PROXY ?? "127.0.0.1:7897");
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    const result = page.locator(".sandbox-result");
    await expect(result).toContainText("连接失败", { timeout: 120000 });
    await expect(result).toContainText("沙箱 DNS：");
    await expect(result).toContainText("Fake-IP");
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("sandbox-system-dns-failure.png"),
      scale: "css",
    });
    await select("DNS 解析", "自动（推荐）");
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(result).toContainText("检查中");
    await expect(result.locator("strong")).toHaveText(/连接正常|连接失败/, {
      timeout: 120000,
    });
    await expect(result).toContainText("连接正常");
    await expect(result).toContainText("HTTP 200");
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("sandbox-proxy-success.png"),
      scale: "css",
    });
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "dark";
      BrowserWindow.getAllWindows()[0]?.setSize(760, 700);
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("textbox", { name: "代理地址", exact: true })
      .scrollIntoViewIfNeeded();
    const bounds = await page
      .locator(".settings-content")
      .evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await page.screenshot({
      path: info.outputPath("sandbox-settings-dark-compact.png"),
      scale: "css",
    });
    await select("出站代理", "不使用显式代理");
    await page
      .getByRole("textbox", { name: "测试域名", exact: true })
      .fill("example.com");
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(result).toContainText("检查中");
    await expect(result.locator("strong")).toHaveText(/连接正常|连接失败/, {
      timeout: 120000,
    });
    await expect(result).toContainText("连接正常");
    await expect(result).toContainText("HTTP 200");
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("sandbox-auto-dns-success.png"),
      scale: "css",
    });
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(result).toContainText("检查中");
    await page.getByRole("button", { name: "停止检查", exact: true }).click();
    await expect(result).toContainText("已停止");
  } finally {
    await desktop.stop();
  }
});
