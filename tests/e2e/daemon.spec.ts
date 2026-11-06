import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { daemonStatus } from "../../src/daemon/lifecycle.js";
import { callWorker, readWorker } from "../../src/worker/client.js";
import { piModelServer } from "../helpers/pi-model-server.js";
import { newBot } from "./new-conversation.js";
import { data } from "./ipc-result.js";
import { snapshotUpdateSchema } from "../../src/shared/snapshot.js";
import { selectSetting } from "../helpers/settings-controls.js";

test("local daemon finishes accepted work after window release and only explicit stop ends its lifecycle", async ({
  desktop,
}, info) => {
  let complete: (() => void) | undefined;
  const model = await piModelServer((_request, send) => {
    complete = () => {
      send({ role: "assistant", content: "后台继续完成" });
      send({}, "stop");
    };
  });
  try {
    const app = await desktop.launch();
    let page = await openDesktop(app);
    const endpoint = await readWorker(desktop.directory);
    const status = data(
      await page.evaluate(() =>
        window.aster.agentConnections({ action: "status" }),
      ),
    );
    data(
      await page.evaluate((request) => window.aster.agentConnections(request), {
        action: "save" as const,
        revision: status.revision,
        config: {
          defaultAgent: model.connection.id,
          connections: [model.connection],
        },
      }),
    );
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("本地后台");
    await selectSetting(
      page,
      "Bot 供应商",
      `${model.connection.id} · ${model.connection.model}`,
    );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const overview = snapshotUpdateSchema.parse(
      await callWorker(endpoint, "/snapshot", {}),
    );
    if (!overview.changed || !overview.snapshot.conversations[0])
      throw Error("Missing conversation");
    const conversationId = overview.snapshot.conversations[0].id;
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("关闭窗口后继续执行");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(1);
    await page.evaluate(() => window.aster.windowAction("close"));
    await expect.poll(() => app.windows().length).toBe(0);
    expect((await daemonStatus(desktop.directory))?.pid).toBe(endpoint.pid);
    expect(complete).toBeDefined();
    complete?.();
    complete = undefined;
    await expect
      .poll(async () => {
        const view = snapshotUpdateSchema.parse(
          await callWorker(endpoint, "/snapshot", { conversationId }),
        );
        return (
          view.changed &&
          view.snapshot.runs.some((run) => run.status === "completed")
        );
      })
      .toBe(true);
    const opened = app.waitForEvent("window");
    await app.evaluate(({ app }) => app.emit("second-instance"));
    page = await opened;
    await expect(page.locator(".message.assistant")).toContainText(
      "后台继续完成",
    );
    await page.screenshot({
      path: info.outputPath("local-background-complete.png"),
    });
    await page
      .evaluate(() =>
        window.aster.command({
          id: crypto.randomUUID(),
          command: { type: "worker.stop" },
        }),
      )
      .catch(() => {});
    await expect.poll(() => daemonStatus(desktop.directory)).toBeNull();
    expect(model.requests).toHaveLength(1);
  } finally {
    complete?.();
    await model.close();
  }
});
