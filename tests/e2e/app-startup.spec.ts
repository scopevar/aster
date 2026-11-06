import { test, expect } from "../helpers/desktop-test.js";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store } from "../../src/storage/store.js";
import { localWorkspaceStatusSchema } from "../../src/shared/local-workspace.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { newBot } from "./new-conversation.js";

// Owner: real Electron/Main/preload/daemon with fresh data and an unavailable cloud.
test("fresh local desktop enters directly, creates a Bot and never contacts the configured unavailable cloud", async ({
  desktop,
}, info) => {
  let requests = 0;
  const cloud = createServer((_request, response) => {
    requests++;
    response.writeHead(503);
    response.end("offline");
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  if (!address || typeof address === "string")
    throw Error("fixture port missing");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const app = await desktop.launch({
      env: {
        ASTER_CLOUD_ORIGIN: origin,
        ASTER_ACCOUNT_ORIGIN: origin,
        ASTER_CONSOLE_ORIGIN: origin,
      },
    });
    const page = await openDesktop(app);
    await expect(page).toHaveTitle("Aster");
    expect(await app.evaluate(({ app }) => app.getName())).toBe("Aster");
    await expect(
      page.getByRole("button", { name: "市场", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "联系人", exact: true }),
    ).toHaveCount(0);
    // ProcessMetric.sandboxed is macOS/Windows-only; Linux exposes seccomp in /proc.
    if (process.platform === "linux") {
      const pid = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
      );
      expect(pid).toBeGreaterThan(0);
      const status = await readFile(
        join("/proc", String(pid), "status"),
        "utf8",
      );
      expect(status).toMatch(/^Seccomp:\s+2$/m);
    } else {
      const sandboxed = await app.evaluate(({ app, BrowserWindow }) => {
        const pid =
          BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
        return app.getAppMetrics().find((process) => process.pid === pid)
          ?.sandboxed;
      });
      expect(sandboxed).toBe(true);
    }
    expect(
      await page.evaluate(() => [
        typeof Reflect.get(window, "require"),
        typeof Reflect.get(window, "process"),
      ]),
    ).toEqual(["undefined", "undefined"]);
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("无需账户的 Bot");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.locator(".conversation-title")).toHaveText(
      "无需账户的 Bot",
    );
    await page.screenshot({ path: info.outputPath("local-desktop.png") });
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await expect(
      page.getByRole("menuitem", { name: "退出登录", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "团队", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "设备与主机", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "模型与连接", exact: true }),
    ).toBeVisible();
    expect(requests).toBe(0);
    await expect(
      readFile(join(desktop.directory, "account.sealed")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "dark";
      BrowserWindow.getAllWindows()[0]?.setSize(900, 680);
    });
    await page.screenshot({
      path: info.outputPath("local-settings-dark-compact.png"),
    });
  } finally {
    cloud.closeAllConnections();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
  }
});

test("legacy guest and account data require a visible choice before opening the local workspace", async ({
  desktop,
}, info) => {
  const accountId = randomUUID();
  const paths = [
    join(desktop.directory, "accounts", "guest"),
    join(desktop.directory, "accounts", accountId, "host-v1"),
  ];
  for (const [index, path] of paths.entries()) {
    await mkdir(path, { recursive: true });
    const store = new Store(join(path, "aster.sqlite"));
    store.execute({
      id: randomUUID(),
      command: {
        type: "bot.create",
        name: index ? "Account Bot" : "Guest Bot",
        description: "",
      },
    });
    store.close();
  }
  const original = await readFile(join(paths[0]!, "aster.sqlite"));
  const app = await desktop.launch();
  const page = await app.firstWindow();
  const choice = page.getByRole("main", { name: "选择本地工作区" });
  await expect(choice).toBeVisible();
  await expect(page.locator(".main-page")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("local-data-choice.png") });
  await choice.getByRole("radio", { name: "访客", exact: true }).focus();
  await choice.getByRole("radio", { name: "访客", exact: true }).press("Space");
  await choice.getByRole("button", { name: "迁移并进入", exact: true }).click();
  await expect(page.locator(".main-page")).toBeVisible();
  const conversations = page.locator(".bot-list");
  await expect(
    conversations.getByRole("button", { name: "Guest Bot", exact: true }),
  ).toBeVisible();
  await expect(
    conversations.getByRole("button", { name: "Account Bot", exact: true }),
  ).toHaveCount(0);
  const result = await page.evaluate(() =>
    window.aster.localWorkspace({ action: "status" }),
  );
  if (!result.success) throw Error(result.error.message);
  const state = localWorkspaceStatusSchema.parse(result.data);
  expect(state.backup).toBeTruthy();
  expect(await readFile(join(paths[0]!, "aster.sqlite"))).toEqual(original);
  const backup = new Store(join(state.backup!, "workspace", "aster.sqlite"));
  try {
    expect(backup.views.snapshot({}).bots[0]?.name).toBe("Guest Bot");
  } finally {
    backup.close();
  }
});
