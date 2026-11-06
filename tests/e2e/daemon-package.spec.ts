import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { standaloneDesktop } from "../helpers/standalone-desktop.js";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { readWorker } from "../../src/worker/client.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { data } from "./ipc-result.js";
import { newBot } from "./new-conversation.js";
import { selectSetting } from "../helpers/settings-controls.js";
import { daemonCli } from "../helpers/daemon-cli.js";
import { randomUUID } from "node:crypto";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";
import { resultSchema } from "../../src/shared/core.js";
import { snapshotUpdateSchema } from "../../src/shared/snapshot.js";

const packageDirectory = resolve(
  process.env.ASTER_PACKAGE_DIR ?? "release/win-unpacked",
);

test("installed desktop reuses Electron Node mode and explicitly stops it without system Node", async ({}, info) => {
  test.skip(
    process.platform !== "win32" || !process.env.ASTER_PACKAGE_TEST,
    "Requires the local Windows package.",
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-packaged-daemon-"));
  const model = await piModelServer();
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const environment = {
    ASTER_DATA_DIR: directory,
    ASTER_DISABLE_AUTO_UPDATE: "1",
    ASTER_NODE_BIN: "must-not-be-used",
    ELECTRON_RUN_AS_NODE: "",
    PATH: [
      systemRoot,
      join(systemRoot, "System32"),
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";"),
  };
  let desktop: Awaited<ReturnType<typeof standaloneDesktop>> | undefined;
  try {
    const runtime = join(packageDirectory, "aster.exe");
    const { stdout } = await promisify(execFile)(
      runtime,
      [
        "--input-type=module",
        "-e",
        `
      import sharp from 'sharp';
      const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer().then(bytes => sharp(bytes).metadata());
      if (image.width !== 2) throw Error('packaged native image runtime failed');
      console.log('native image runtime ready');
    `,
      ],
      {
        cwd: join(packageDirectory, "resources/app.asar.unpacked"),
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    expect(stdout).toContain("native image runtime ready");
    desktop = await standaloneDesktop(
      environment,
      join(packageDirectory, "aster.exe"),
    );
    const page = await desktop.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("dialog", { name: "登录 Aster", exact: true }),
    ).toHaveCount(0);
    const endpoint = await readWorker(directory);
    expect(endpoint.kind).toBe("daemon");
    expect(endpoint.pid).not.toBe(desktop.process.pid);
    const state = data(
      await page.evaluate(() =>
        window.aster.agentConnections({ action: "status" }),
      ),
    );
    data(
      await page.evaluate((input) => window.aster.agentConnections(input), {
        action: "save" as const,
        revision: state.revision,
        config: {
          defaultAgent: model.connection.id,
          connections: [model.connection],
        },
      }),
    );
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("安装版本机 Bot");
    await selectSetting(
      page,
      "Bot 供应商",
      `${model.connection.id} · ${model.connection.model}`,
    );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("bundle runtime");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("Hello Pi", {
      timeout: 20000,
    });
    await page.screenshot({
      path: info.outputPath("packaged-runtime-task.png"),
    });
    expect((await daemonStatus(directory))?.pid).toBe(endpoint.pid);
    const command = page.evaluate(() =>
      window.aster.command({
        id: crypto.randomUUID(),
        command: { type: "worker.stop" },
      }),
    );
    // The explicit stop command closes the app, so the renderer may disappear after acknowledgement.
    await command.catch(() => {});
    await expect.poll(async () => await daemonStatus(directory)).toBeNull();
    expect(await desktop.exited).toBe(0);
    desktop = undefined;
    desktop = await standaloneDesktop(
      environment,
      join(packageDirectory, "aster.exe"),
    );
    const reopened = await desktop.firstWindow();
    await expect(reopened.locator(".sidebar")).toBeVisible();
    expect((await readWorker(directory)).role).toBe("execution");
    await desktop.close();
    desktop = undefined;
    expect(await daemonStatus(directory)).not.toBeNull();
  } finally {
    await desktop?.close();
    if (await daemonStatus(directory)) await stopDaemon(directory);
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed CLI configures and executes through Electron Node mode", async () => {
  test.skip(
    process.platform !== "win32" || !process.env.ASTER_PACKAGE_TEST,
    "Requires the local Windows package",
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-packaged-daemon-cli-"));
  const model = await piModelServer();
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const environment = {
    ELECTRON_RUN_AS_NODE: "1",
    PATH: [
      systemRoot,
      join(systemRoot, "System32"),
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";"),
  };
  const launch = {
    executable: join(packageDirectory, "aster.exe"),
    script: join(
      packageDirectory,
      "resources/app.asar.unpacked/node_modules/@aster/cli/dist/cli/main.js",
    ),
  };
  const cli = (action: string, body?: unknown) =>
    daemonCli(directory, action, body, environment, launch);
  try {
    await cli("start");
    const state = agentConnectionsStatusSchema.parse(
      await cli("models", { action: "status" }),
    );
    await cli("models", {
      action: "save",
      revision: state.revision,
      config: {
        defaultAgent: model.connection.id,
        connections: [model.connection],
      },
    });
    const bot = resultSchema.parse(
      await cli("command", {
        id: randomUUID(),
        command: {
          type: "bot.create",
          name: "独立安装 CLI Bot",
          description: "",
        },
      }),
    );
    await cli("models", {
      action: "assign",
      botId: bot.id,
      connectionId: model.connection.id,
    });
    await cli("command", {
      id: randomUUID(),
      command: {
        type: "message.send",
        conversationId: bot.conversationId,
        text: "bundled CLI runtime",
      },
    });
    const snapshot = async () =>
      snapshotUpdateSchema.parse(
        await cli("snapshot", { conversationId: bot.conversationId }),
      );
    await expect
      .poll(
        async () => {
          const view = await snapshot();
          if (
            view.changed &&
            view.snapshot.runs.some((run) => run.status === "failed")
          )
            throw Error(
              JSON.stringify(
                view.snapshot.runs.map(({ status, error }) => ({
                  status,
                  error,
                })),
              ),
            );
          return (
            view.changed &&
            view.snapshot.messages.some((m) => m.text.includes("Hello Pi"))
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    await cli("stop");
    await cli("start");
    const restored = await snapshot();
    expect(
      restored.changed &&
        restored.snapshot.messages.some((m) => m.text.includes("Hello Pi")),
    ).toBe(true);
    expect(model.requests).toHaveLength(1);
    await cli("stop");
    expect(await daemonStatus(directory)).toBeNull();
  } finally {
    if (await daemonStatus(directory)) await stopDaemon(directory);
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
