import { piModelServer } from "../helpers/pi-model-server.js";
import { data } from "./ipc-result.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callWorker } from "../../src/worker/client.js";
import { workerRoutes } from "../../src/shared/protocol.js";
import { resultSchema } from "../../src/shared/core.js";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { workerSnapshot } from "../helpers/worker-snapshot.js";

test("native directory consent and file isolation remain enforced without renderer access to the worker origin", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "directory-consent-"));
  const chosen = join(directory, "chosen");
  const proof = `GRANTED_FILE_${randomUUID()}`;
  let modelPath = "";
  const model = await piModelServer((request, send) => {
    const result = request.messages.find((message) => message.role === "tool");
    if (result) {
      send({
        role: "assistant",
        content:
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
      });
      send({}, "stop");
    } else {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "authorized-read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: modelPath }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    }
  });
  const worker = await startWorker(directory);
  await mkdir(chosen);
  await writeFile(join(chosen, "source.txt"), proof);
  const create = async (name: string) =>
    resultSchema.parse(
      await callWorker(worker.endpoint, workerRoutes.command, {
        id: randomUUID(),
        command: { type: "bot.create", name, description: "" },
      }),
    );
  const a = await create("A"),
    b = await create("B");
  if (!a.id || !b.id || !a.conversationId || !b.conversationId)
    throw new Error("Missing conversations");
  const env: Record<string, string> = { ASTER_DATA_DIR: directory };
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "ASTER_DATA_DIR") env[key] = value;
  const app = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toBeVisible();
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain("ws://");
    const outside = await app.evaluate(
      async ({ session }, url) => {
        const response = await session.defaultSession.fetch(url);
        return { status: response.status, text: await response.text() };
      },
      pathToFileURL(join(chosen, "source.txt")).href,
    );
    expect(outside.status).toBe(403);
    expect(outside.text).not.toContain(proof);
    const raw = await page.evaluate(
      async ({ conversationId, root }) => {
        const invoke = (
          request: unknown,
        ): ReturnType<typeof window.aster.command> =>
          Reflect.apply(window.aster.command, window.aster, [request]);
        return invoke({
          id: crypto.randomUUID(),
          command: { type: "directory.attach", conversationId, root },
        });
      },
      {
        conversationId: a.conversationId,
        root: chosen,
      },
    );
    expect(raw.success).toBe(false);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, chosen);
    const result = await page.evaluate(
      async ({ a, b }) => {
        const invoke = (
          request: unknown,
        ): ReturnType<typeof window.aster.command> =>
          Reflect.apply(window.aster.command, window.aster, [request]);
        const selected = await window.aster.chooseDirectory(a);
        if (!selected.success || !selected.data)
          throw new Error("Picker failed");
        const credential = selected.data;
        const request = {
          id: crypto.randomUUID(),
          command: { type: "directory.attach", conversationId: a, credential },
        };
        const wrongConversation = await invoke({
          ...request,
          command: { ...request.command, conversationId: b },
        });
        const accepted = await invoke(request);
        const retry = await invoke(request);
        const reuse = await invoke({ ...request, id: crypto.randomUUID() });
        return { credential, wrongConversation, accepted, retry, reuse };
      },
      {
        a: a.conversationId,
        b: b.conversationId,
      },
    );
    expect(result.credential).not.toContain(chosen);
    expect(result.wrongConversation.success).toBe(false);
    expect(result.accepted, JSON.stringify(result.accepted)).toMatchObject({
      success: true,
    });
    expect(result.retry).toEqual(result.accepted);
    expect(result.reuse.success).toBe(false);
    const snapshot = await workerSnapshot(worker.endpoint);
    expect(
      snapshot.conversations.find((c) => c.id === a.conversationId)
        ?.directoryGrants,
    ).toHaveLength(1);
    expect(
      snapshot.conversations.find((c) => c.id === b.conversationId)
        ?.directoryGrants,
    ).toHaveLength(0);
    const grant = snapshot.conversations.find((c) => c.id === a.conversationId)
      ?.directoryGrants[0];
    if (!grant) throw Error("Missing granted directory");
    modelPath = `/grants/${grant.id}/source.txt`;
    const settings = data(
      await page.evaluate(() =>
        window.aster.agentConnections({ action: "status" }),
      ),
    );
    data(
      await page.evaluate((request) => window.aster.agentConnections(request), {
        action: "save" as const,
        revision: settings.revision,
        config: {
          defaultAgent: model.connection.id,
          connections: [model.connection],
        },
      }),
    );
    data(
      await page.evaluate((request) => window.aster.agentConnections(request), {
        action: "assign" as const,
        botId: a.id,
        connectionId: model.connection.id,
      }),
    );
    await page.getByRole("button", { name: "A", exact: true }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("读取已授权文件");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText(proof);
    expect(model.requests).toHaveLength(2);
    await page
      .getByRole("button", { name: `撤销目录授权 ${chosen}`, exact: true })
      .click();
    await expect(page.getByLabel("已授权目录", { exact: true })).toHaveCount(0);
    await worker.stop();
    await page.reload();
    await expect(
      page.getByRole("main", { name: "选择本地工作区" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await worker.stop();
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
