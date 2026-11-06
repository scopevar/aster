import { test, expect, _electron as electron } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
  cp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentConnections } from "../../src/agent/connections.js";
import { modelConfigPath } from "../../src/agent/config-file.js";
import { readWorker } from "../../src/worker/client.js";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { workerSnapshot } from "../helpers/worker-snapshot.js";
import { newBot } from "./new-conversation.js";

test("script approval, refusal and actual microVM execution fit both themes and window sizes", async () => {
  test.skip(
    process.env.ASTER_TEST_MICROSANDBOX !== "1",
    "requires a real Microsandbox host",
  );
  test.setTimeout(180000);
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "script-ui-"));
  const proof = randomBytes(16).toString("hex");
  const command = `printf '${proof}' > ui-proof.txt\npython3 -c 'print("UI_MICROVM_EXECUTED")'`;
  let network: string[] = [];
  const model = await piModelServer((request, send) => {
    const lastUser = request.messages.findLastIndex((m) => m.role === "user");
    if (request.messages.slice(lastUser + 1).some((m) => m.role === "tool")) {
      const completed = request.messages
        .slice(lastUser + 1)
        .some((message) =>
          JSON.stringify(message.content).includes("UI_MICROVM_EXECUTED"),
        );
      send({
        role: "assistant",
        content: completed
          ? "脚本调用结果已记录。[结果](sandbox:/workspace/ui-proof.txt)"
          : "脚本调用结果已记录。",
      });
      send({}, "stop");
      return;
    }
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `script-ui-${Date.now()}`,
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command,
              network,
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  });
  const home = join(directory, "agent");
  await mkdir(home);
  await writeFile(
    modelConfigPath(home),
    JSON.stringify({
      defaultAgent: "fixture",
      connections: [model.connection],
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (p): p is [string, string] => p[1] !== undefined,
    ),
  );
  env.ASTER_DATA_DIR = directory;
  env.ASTER_DISABLE_AUTO_UPDATE = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const data = localWorkspaceDirectory(directory);
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
  const app = await electron.launch({
    args: [resolve(".")],
    env,
    colorScheme: null,
  });
  try {
    const page = await openDesktop(app);
    const endpoint = await readWorker(directory);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "light";
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 800);
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("隔离脚本验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const snapshot = await workerSnapshot(endpoint);
    const bot = snapshot.bots.find((b) => b.name === "隔离脚本验收");
    expect(bot).toBeTruthy();
    if (!bot) throw Error("Bot missing");
    await new AgentConnections(home).request(
      { action: "assign", botId: bot.id, connectionId: "fixture" },
      AbortSignal.timeout(5000),
    );
    const work = join(data, "workspaces", bot.id, "script-work");
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
    };
    const idle = async () => {
      await expect(
        page.getByRole("button", { name: "停止回复", exact: true }),
      ).toHaveCount(0, { timeout: 120000 });
    };
    await send("请运行隔离脚本，先等待我批准。");
    const pending = page.locator(".computer-tool.pending");
    await expect(pending).toContainText(command);
    await expect(pending).toContainText("网络：禁止");
    await expect(
      pending.getByRole("button", { name: "允许一次", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        try {
          await access(join(work, "ui-proof.txt"));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    await page.screenshot({
      path: test.info().outputPath("script-pending-light.png"),
    });
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "dark";
      BrowserWindow.getAllWindows()[0]?.setSize(820, 700);
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      pending.getByRole("button", { name: "拒绝", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("script-pending-dark-narrow.png"),
    });
    await pending.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(page.locator(".computer-tool.declined")).toBeVisible();
    await idle();
    await expect
      .poll(async () => {
        try {
          await access(join(work, "ui-proof.txt"));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    await send("现在允许执行同一条隔离脚本。");
    await page
      .locator(".computer-tool.pending")
      .getByRole("button", { name: "允许一次", exact: true })
      .click();
    await expect(page.locator(".computer-tool.completed")).toBeVisible({
      timeout: 120000,
    });
    await idle();
    expect(await readFile(join(work, "ui-proof.txt"), "utf8")).toBe(proof);
    await expect(page.getByText("ui-proof.txt", { exact: true })).toBeVisible();
    await page
      .locator(".tool-card.completed")
      .getByRole("button", { name: /执行命令/ })
      .click();
    await expect(page.getByLabel("命令输出", { exact: true })).toContainText(
      "UI_MICROVM_EXECUTED",
    );
    await page.screenshot({
      path: test.info().outputPath("script-completed-dark.png"),
    });
    network = ["example.com"];
    await send("请求一个 HTTPS 范围，等待我审核。");
    await expect(page.locator(".computer-tool.pending")).toContainText(
      "HTTPS：example.com",
    );
    await page.screenshot({
      path: test.info().outputPath("script-network-approval.png"),
    });
    await page
      .locator(".computer-tool.pending")
      .getByRole("button", { name: "拒绝", exact: true })
      .click();
    await idle();
  } finally {
    await app.close();
    if (await daemonStatus(directory)) await stopDaemon(directory);
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
