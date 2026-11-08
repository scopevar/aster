import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Electron owns external-browser dispatch and the sandbox bridge. The external
// browser is captured; no real account login or inference is performed here.
test("subscription login opens only OpenAI through Main and cancellation releases the real callback", async ({
  desktop,
}, info) => {
  const app = await desktop.launch();
  await app.evaluate(({ shell, BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "light";
    BrowserWindow.getAllWindows()[0]?.setSize(1050, 850);
    const urls: string[] = [];
    Object.defineProperty(globalThis, "asterTestAuthURLs", {
      value: urls,
      configurable: true,
    });
    shell.openExternal = async (url) => {
      urls.push(url);
    };
  });
  const page = await openDesktop(app);
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("region", { name: "设置", exact: true });
  await settings
    .getByRole("button", { name: "模型与连接", exact: true })
    .click();
  await settings.getByRole("button", { name: "添加连接", exact: true }).click();
  const dialog = page.locator(".connection-add-dialog");
  await dialog.getByRole("button", { name: /OpenAI api\.openai\.com/ }).click();
  await dialog.getByText("ChatGPT 订阅登录", { exact: true }).click();
  await dialog
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "取消登录", exact: true }),
  ).toBeVisible();
  const urls: unknown = await app.evaluate(() =>
    Reflect.get(globalThis, "asterTestAuthURLs"),
  );
  expect(Array.isArray(urls)).toBe(true);
  if (!Array.isArray(urls) || typeof urls[0] !== "string")
    throw Error("No browser authorization URL");
  expect(urls).toHaveLength(1);
  const url = new URL(urls[0]);
  expect(url.origin).toBe("https://auth.openai.com");
  expect(url.searchParams.get("agent_name_hint")).toBe("Aster");
  const state = await page.evaluate(() =>
    window.aster.chatGPTAuth({ action: "status" }),
  );
  expect(state.success).toBe(true);
  expect(state).not.toHaveProperty("data.authorizationUrl");
  await page.screenshot({
    path: info.outputPath("electron-chatgpt-pending.png"),
    scale: "css",
  });
  await dialog.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已取消登录");
  await expect(
    readFile(join(desktop.directory, "agent", "pi-auth.sealed")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const result = await fetch(url.searchParams.get("redirect_uri")!).catch(
    () => null,
  );
  expect(result).toBeNull();
});
