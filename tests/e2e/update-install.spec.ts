import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { daemonStatus } from "../../src/daemon/lifecycle.js";
import { callWorker, readWorker } from "../../src/worker/client.js";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";
import { data } from "./ipc-result.js";
import type * as ElectronUpdater from "electron-updater";
import { resolve } from "node:path";

// Real Electron/preload/IPC, Pi and daemon processes. Only the provider response
// and external installer are controlled; no real package is installed on this machine.
test("update waits for work, can be cancelled, and restores the daemon after installer failure", async ({
  desktop,
}, info) => {
  let finish: (() => void) | undefined;
  const model = await piModelServer((_request, send) => {
    send({ role: "assistant", content: "正在执行已有任务" });
    finish = () => send({}, "stop");
  });
  try {
    const app = await desktop.launch({
      env: {
        ASTER_DISABLE_AUTO_UPDATE: "0",
        ASTER_FORCE_DEV_UPDATE: "1",
        ASTER_UPDATE_URL: "http://127.0.0.1:12345/updates/stable/",
      },
    });
    const page = await openDesktop(app);
    const endpoint = await readWorker(desktop.directory);
    const config = agentConnectionsStatusSchema.parse(
      await callWorker(endpoint, "/agent-connections", { action: "status" }),
    );
    await callWorker(endpoint, "/agent-connections", {
      action: "save",
      revision: config.revision,
      config: {
        defaultAgent: model.connection.id,
        connections: [model.connection],
      },
    });
    const bot = data(
      await page.evaluate(() =>
        window.aster.command({
          id: crypto.randomUUID(),
          command: { type: "bot.create", name: "更新等待", description: "" },
        }),
      ),
    );
    expect(bot.conversationId).toBeTruthy();
    await callWorker(endpoint, "/agent-connections", {
      action: "assign",
      botId: bot.id,
      connectionId: model.connection.id,
    });
    await page.evaluate((conversationId) => {
      if (!conversationId) throw Error("Missing conversation");
      return window.aster.command({
        id: crypto.randomUUID(),
        command: { type: "message.send", conversationId, text: "请执行" },
      });
    }, bot.conversationId);
    await expect.poll(() => model.requests.length).toBe(1);
    const queued = data(
      await page.evaluate((botId) => {
        if (!botId) throw Error("Missing bot");
        return window.aster.command({
          id: crypto.randomUUID(),
          command: { type: "conversation.create", botId },
        });
      }, bot.id),
    );
    data(
      await page.evaluate((conversationId) => {
        if (!conversationId) throw Error("Missing queued conversation");
        return window.aster.command({
          id: crypto.randomUUID(),
          command: {
            type: "message.send",
            conversationId,
            text: "重启后处理的排队任务",
          },
        });
      }, queued.conversationId),
    );
    await app.evaluate((_electron, manifestPath) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(manifestPath);
      const { autoUpdater } =
        require("electron-updater") as typeof ElectronUpdater;
      autoUpdater.emit("update-downloaded", {
        version: "9.0.0",
        downloadedFile: "fixture",
        files: [],
        path: "fixture",
        sha512: "",
        releaseDate: "2026-11-06T00:00:00Z",
      });
      autoUpdater.quitAndInstall = () => {
        setImmediate(() =>
          autoUpdater.emit("error", new Error("fixture installer failure")),
        );
      };
    }, resolve("package.json"));
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "更新", exact: true }).click();
    const updates = page.getByRole("region", { name: "应用更新", exact: true });
    await expect(updates).toContainText("下载不影响任务");
    await updates
      .getByRole("button", { name: "安装并重启", exact: true })
      .click();
    await expect(updates).toContainText("1 个会话或后台任务");
    expect((await daemonStatus(desktop.directory))?.pid).toBe(endpoint.pid);
    await page.screenshot({ path: info.outputPath("waiting-live-task.png") });
    await updates
      .getByRole("button", { name: "取消更新", exact: true })
      .click();
    await expect(updates).toContainText("后台恢复接收新任务");
    expect(model.requests).toHaveLength(1);
    expect((await daemonStatus(desktop.directory))?.pid).toBe(endpoint.pid);
    await updates
      .getByRole("button", { name: "安装并重启", exact: true })
      .click();
    await expect(updates).toContainText("1 个会话或后台任务");
    expect(finish).toBeDefined();
    finish?.();
    finish = undefined;
    await expect(updates).toContainText("安装更新失败，后台已恢复运行", {
      timeout: 40_000,
    });
    const restarted = await daemonStatus(desktop.directory);
    expect(restarted?.pid).toBeTruthy();
    expect(restarted?.pid).not.toBe(endpoint.pid);
    expect(await app.evaluate(({ app }) => app.hasSingleInstanceLock())).toBe(
      true,
    );
    await expect(
      updates.getByRole("button", { name: "安装并重启", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: info.outputPath("installer-failure-recovered.png"),
    });
    await expect.poll(() => model.requests.length).toBe(2);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      "重启后处理的排队任务",
    );
  } finally {
    finish?.();
    await desktop.stop();
    await model.close();
  }
});
