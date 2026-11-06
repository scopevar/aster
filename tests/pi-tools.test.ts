import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { AgentConnections } from "../src/agent/connections.js";

await test("Pi uses the existing authorized MCP inventory, records tool context and releases the worker scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-mcp-"));
  const model = await piModelServer((request, send) => {
    if (request.messages.some((message) => message.role === "tool")) {
      send({
        role: "assistant",
        content: "history read through approved scope",
      });
      send({}, "stop");
    } else {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "history-1",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({
                path: "/history",
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    }
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
    const created = await execute({
      type: "bot.create",
      name: "Scoped Pi",
      description: "",
    });
    assert.ok(created.id);
    assert.ok(created.conversationId);
    await new AgentConnections(home).request(
      { action: "assign", botId: created.id, connectionId: "fixture" },
      AbortSignal.timeout(5000),
    );
    const run = await execute({
      type: "message.send",
      conversationId: created.conversationId,
      text: "read history",
    });
    assert.ok(run.id);
    let snapshot = await workerSnapshot(endpoint, {
      conversationId: created.conversationId,
    });
    const deadline = Date.now() + 15000;
    while (
      snapshot.runs.some(
        (item) =>
          item.id === run.id && ["queued", "running"].includes(item.status),
      ) &&
      Date.now() < deadline
    ) {
      await delay(20);
      snapshot = await workerSnapshot(endpoint, {
        conversationId: created.conversationId,
      });
    }
    assert.equal(
      snapshot.runs.find((item) => item.id === run.id)?.status,
      "completed",
    );
    assert.ok(
      snapshot.messages.some((message) =>
        message.text.includes("history read"),
      ),
    );
    assert.deepEqual(
      model.requests[0]?.tools?.map((tool) => tool.function.name).sort(),
      [
        "ask_user",
        "notify",
        "plugins",
        "read",
        "routines",
        "shell",
        "skills",
        "templates",
      ],
    );
    assert.equal(
      model.requests.length,
      2,
      "one tool result and one continuation owned by Pi",
    );
    assert.ok(
      model.requests[1]?.messages.some((message) => message.role === "tool"),
    );
    await worker.stop();
    worker = undefined;
    await assert.rejects(callWorker(endpoint, "/health"));
  } finally {
    await worker?.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
