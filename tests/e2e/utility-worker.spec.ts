import { newBot } from "./new-conversation.js";
import { selectSetting } from "../helpers/settings-controls.js";
import { test, expect } from "../helpers/desktop-test.js";
import {
  daemonStatus,
  ensureDaemon,
  stopDaemon,
} from "../../src/daemon/lifecycle.js";
import { callWorker, readWorker } from "../../src/worker/client.js";
import { ownDirectory } from "../../src/platform/directory-lease.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { data } from "./ipc-result.js";
import { resolve } from "node:path";

test("desktop reconnects to an explicitly restarted local daemon without replaying completed work", async ({
  desktop,
}) => {
  const model = await piModelServer();
  try {
    const app = await desktop.launch();
    const page = await openDesktop(app);
    const state = data(
      await page.evaluate(() =>
        window.aster.agentConnections({ action: "status" }),
      ),
    );
    data(
      await page.evaluate((request) => window.aster.agentConnections(request), {
        action: "save" as const,
        revision: state.revision,
        config: {
          defaultAgent: model.connection.id,
          connections: [model.connection],
        },
      }),
    );
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("本地重连");
    await selectSetting(
      page,
      "Bot 供应商",
      `${model.connection.id} · ${model.connection.model}`,
    );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const snapshot = data(await page.evaluate(() => window.aster.snapshot({})));
    if (!snapshot.changed || !snapshot.snapshot.conversations[0])
      throw Error("Missing conversation");
    const conversationId = snapshot.snapshot.conversations[0].id;
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("local reconnect");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("Hello Pi");
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    const original = await readWorker(desktop.directory);
    expect(original.pid).not.toBe(await app.evaluate(() => process.pid));
    expect(
      model.requests[0]?.tools?.map((tool) => tool.function.name),
    ).toHaveLength(8);
    process.kill(original.pid, "SIGKILL");
    await expect
      .poll(async () => {
        try {
          process.kill(original.pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    const recovered = await ensureDaemon(desktop.directory, {
      executable: process.execPath,
      script: resolve("node_modules/@aster/cli/dist/cli/main.js"),
    });
    expect(recovered.pid).not.toBe(original.pid);
    await expect
      .poll(
        async () => {
          const response = await page.evaluate(
            (conversationId) => window.aster.snapshot({ conversationId }),
            conversationId,
          );
          return (
            response.success &&
            response.data.changed &&
            response.data.snapshot.messages.some((message) =>
              message.text.includes("Hello Pi"),
            )
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    await expect(page.locator(".conversation-title")).toContainText("本地重连");
    await expect(page.locator(".message.assistant")).toContainText("Hello Pi");
    expect(model.requests).toHaveLength(1);
    await callWorker(recovered, "/snapshot", {
      conversationId,
    });
    await app.close();
    expect((await daemonStatus(desktop.directory))?.pid).toBe(recovered.pid);
    await stopDaemon(desktop.directory);
    expect(await daemonStatus(desktop.directory)).toBeNull();
    const lease = await ownDirectory(desktop.directory, "worker");
    await lease.close();
  } finally {
    await model.close();
  }
});
