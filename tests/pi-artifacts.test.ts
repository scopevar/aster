import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import sharp from "sharp";
import { AgentConnections } from "../src/agent/connections.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { startWorker } from "../src/worker/server.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";
import { callWorker } from "../src/worker/client.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { attachmentContentSchema } from "../src/shared/files/attachments.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

// The wire fixture chooses model actions; Pi, MCP image delivery, scoped reads,
// attachment persistence and final run status are production implementations.
await test("Pi reads real images and delivers file links without an export tool; invalid paths fail visibly", async () => {
  const results = resolve(".runtime/test-results");
  await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(results, "pi-file-delivery-"));
  let final =
    "报告：[report.txt](sandbox:/workspace/report.txt)\n示例代码：`[example](sandbox:/workspace/nonexistent.txt)`";
  const model = await piModelServer((request, send) => {
    if (request.messages.some((message) => message.role === "tool")) {
      send({ role: "assistant", content: final });
      send({}, "stop");
      return;
    }
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: randomUUID(),
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "/workspace/blue.png" }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const home = join(root, "agent");
    await mkdir(home);
    await writeFile(
      modelConfigPath(home),
      JSON.stringify({
        defaultAgent: "fixture",
        connections: [model.connection],
      }),
    );
    worker = await startWorker(root, { port: 0 });
    const endpoint = worker.endpoint;
    const execute = async (command: Command) =>
      resultSchema.parse(
        await callWorker(endpoint, "/command", { id: randomUUID(), command }),
      );
    const bot = await execute({
      type: "bot.create",
      name: "File delivery",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    const conversationId = bot.conversationId;
    await new AgentConnections(home).request(
      { action: "assign", botId: bot.id, connectionId: "fixture" },
      AbortSignal.timeout(5000),
    );
    const work = join(
      localWorkspaceDirectory(root),
      "workspaces",
      bot.id,
      "script-work",
    );
    await mkdir(work, { recursive: true });
    const content = `REPORT_${randomUUID()}`;
    await writeFile(join(work, "report.txt"), content);
    await sharp({
      create: { width: 13, height: 7, channels: 3, background: "blue" },
    })
      .png()
      .toFile(join(work, "blue.png"));
    const finish = async (id: string) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const view = await workerSnapshot(endpoint, { conversationId });
        const run = view.runs.find((item) => item.id === id);
        if (run && !["queued", "running", "cancelling"].includes(run.status))
          return { view, run };
        assert.ok(Date.now() < deadline, "file delivery did not settle");
        await delay(20);
      }
    };
    const sent = await execute({
      type: "message.send",
      conversationId,
      text: "Read the blue image and deliver the report",
    });
    assert.ok(sent.id);
    const result = await finish(sent.id);
    assert.equal(result.run.status, "completed", result.run.error ?? "");
    const generated = result.view.messages
      .flatMap((message) => message.attachments)
      .filter((file) => file.name === "report.txt");
    assert.equal(generated.length, 1);
    const downloaded = attachmentContentSchema.parse(
      await callWorker(
        endpoint,
        `/attachments/content?id=${generated[0]!.id}&conversationId=${conversationId}`,
      ),
    );
    assert.equal(Buffer.from(downloaded.data, "base64").toString(), content);
    assert.ok(
      result.view.messages.some(
        (message) =>
          message.text ===
          "报告：report.txt\n示例代码：`[example](sandbox:/workspace/nonexistent.txt)`",
      ),
    );
    const continuation = model.requests[1];
    assert.ok(continuation);
    assert.match(
      JSON.stringify(continuation.messages),
      /data:image\/png;base64,/,
    );
    assert.doesNotMatch(
      JSON.stringify(continuation.tools),
      /"(?:documents|scripts|files|history|export)"/,
    );
    final = "[private](sandbox:/workspace/../private.txt)";
    const invalid = await execute({
      type: "message.send",
      conversationId,
      text: "Reject traversal",
    });
    assert.ok(invalid.id);
    const rejected = await finish(invalid.id);
    assert.equal(rejected.run.status, "failed");
    assert.match(rejected.run.error ?? "", /文件.*未能确认/);
    assert.equal(
      rejected.view.messages.flatMap((message) => message.attachments).length,
      1,
    );
  } finally {
    await worker?.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
