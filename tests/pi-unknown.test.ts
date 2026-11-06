import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "../src/chat/agent.js";
import { PiAgent } from "../src/agent/pi.js";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { loseSkillCreateResponse } from "./e2e/lost-tool-response.js";

await test("a lost MCP mutation reply is recorded unknown and Pi never repeats the side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-unknown-"));
  const model = await piModelServer((_request, send) => {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "write-1",
          type: "function",
          function: {
            name: "skills",
            arguments: JSON.stringify({
              operation: {
                action: "create",
                name: "Saved once",
                description: "fixture",
                body: "Only a fixture",
              },
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let dropped = false;
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
    const pi = new PiAgent(home, model.connection);
    const faulted: Agent = {
      check: (signal) => pi.check(signal),
      async run(input) {
        assert.ok(input.toolAccess);
        const fault = await loseSkillCreateResponse(input.toolAccess);
        try {
          return await pi.run({ ...input, toolAccess: fault.access });
        } finally {
          dropped = fault.dropped;
          await fault.close();
        }
      },
    };
    worker = await startWorker(root, { port: 0, agent: faulted });
    const endpoint = worker.endpoint;
    const execute = async (command: Command) =>
      resultSchema.parse(
        await callWorker(endpoint, "/command", { id: randomUUID(), command }),
      );
    const created = await execute({
      type: "bot.create",
      name: "Unknown Pi",
      description: "",
    });
    assert.ok(created.conversationId);
    assert.ok(created.id);
    const run = await execute({
      type: "message.send",
      conversationId: created.conversationId,
      text: "create a skill once",
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
    const finished = snapshot.runs.find((item) => item.id === run.id);
    assert.equal(finished?.status, "unknown");
    assert.match(finished.error ?? "", /结果未能确认|结果未知/);
    assert.equal(dropped, true);
    assert.equal(model.requests.length, 1);
    assert.equal(
      snapshot.messages.filter(
        (message) => message.text === "已创建技能：Saved once · v1",
      ).length,
      1,
    );
  } finally {
    await worker?.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
