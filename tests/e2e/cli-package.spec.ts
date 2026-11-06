import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { standaloneDesktop } from "../helpers/standalone-desktop.js";
import { daemonCli } from "../helpers/daemon-cli.js";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";
import { snapshotUpdateSchema } from "../../src/shared/snapshot.js";
import { newBot } from "./new-conversation.js";
import { selectSetting } from "../helpers/settings-controls.js";

for (const mode of ["external", "bundled"] as const) {
  test(`Desktop uses the ${mode} CLI package and window/controller exit preserve execution`, async ({}, info) => {
    test.skip(
      process.platform !== "win32" ||
        !process.env.ASTER_PACKAGE_DIR ||
        (mode === "external" && !process.env.ASTER_CLI_INSTALL_DIR),
      "Requires local package artifacts",
    );
    const installed = resolve(process.env.ASTER_PACKAGE_DIR!);
    const directory = await mkdtemp(join(tmpdir(), "aster-cli-desktop-"));
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const timers = new Set<NodeJS.Timeout>();
    const model = await piModelServer((_request, send) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        send({ role: "assistant", content: "Hello Pi" });
        send({}, "stop");
      }, 4000);
      timers.add(timer);
    });
    const executable =
      mode === "external" ? process.execPath : join(installed, "aster.exe");
    const script =
      mode === "external"
        ? join(
            process.env.ASTER_CLI_INSTALL_DIR!,
            "node_modules/@aster/cli/dist/cli/main.js",
          )
        : join(
            installed,
            "resources/app.asar.unpacked/node_modules/@aster/cli/dist/cli/main.js",
          );
    const cli = (action: string, body?: unknown) =>
      daemonCli(
        directory,
        action,
        body,
        { ELECTRON_RUN_AS_NODE: mode === "bundled" ? "1" : "" },
        { executable, script },
      );
    let desktop: Awaited<ReturnType<typeof standaloneDesktop>> | undefined;
    try {
      if (mode === "external") await cli("start");
      const existing = await daemonStatus(directory);
      desktop = await standaloneDesktop(
        {
          ASTER_DATA_DIR: directory,
          ASTER_DISABLE_AUTO_UPDATE: "1",
          ASTER_NODE_BIN: "must-not-be-used",
          PATH: [
            systemRoot,
            join(systemRoot, "System32"),
            join(systemRoot, "System32/WindowsPowerShell/v1.0"),
          ].join(";"),
        },
        join(installed, "aster.exe"),
      );
      let page = await desktop.firstWindow();
      const endpoint = await daemonStatus(directory);
      expect(endpoint?.kind).toBe("daemon");
      if (existing) expect(endpoint?.pid).toBe(existing.pid);
      await page.reload();
      await expect(
        page.getByRole("dialog", { name: "登录 Aster", exact: true }),
      ).toHaveCount(0);
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
      await newBot(page);
      await page.getByLabel("名称", { exact: true }).fill("独立 CLI 包 Bot");
      await selectSetting(
        page,
        "Bot 供应商",
        `${model.connection.id} · ${model.connection.model}`,
      );
      await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
      await page
        .getByRole("textbox", { name: "消息", exact: true })
        .fill("窗口退出后继续运行");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect.poll(() => model.requests.length).toBe(1);
      const overview = snapshotUpdateSchema.parse(await cli("snapshot", {}));
      if (!overview.changed) throw new Error("Missing initial snapshot");
      const bot = overview.snapshot.bots.find(
        (item) => item.name === "独立 CLI 包 Bot",
      );
      const conversationId = overview.snapshot.conversations.find(
        (item) => item.botId === bot?.id,
      )?.id;
      if (!conversationId) throw new Error("Created Bot has no conversation");
      await page.evaluate(() => {
        void window.aster.windowAction("close");
      });
      await expect.poll(() => desktop!.windows().length).toBe(0);
      expect((await daemonStatus(directory))?.pid).toBe(endpoint?.pid);
      await expect
        .poll(
          async () => {
            const view = snapshotUpdateSchema.parse(
              await cli("snapshot", { conversationId }),
            );
            return (
              view.changed &&
              view.snapshot.runs.some((run) => run.status === "completed")
            );
          },
          { timeout: 30000 },
        )
        .toBe(true);
      await desktop.reopen();
      page = await desktop.firstWindow();
      await expect(page.locator(".message.assistant")).toContainText(
        "Hello Pi",
      );
      await page.screenshot({
        path: info.outputPath(`${mode}-cli-package.png`),
      });
      await desktop.close();
      desktop = undefined;
      expect((await daemonStatus(directory))?.pid).toBe(endpoint?.pid);
      expect(model.requests.length).toBe(1);
      await cli("stop");
      expect(await daemonStatus(directory)).toBe(null);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await desktop?.close();
      if (await daemonStatus(directory)) await stopDaemon(directory);
      await model.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
