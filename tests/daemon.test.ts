import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { daemonCli } from "./helpers/daemon-cli.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { callWorker } from "../src/worker/client.js";
import {
  daemonStatus,
  ensureDaemon,
  stopDaemon,
} from "../src/daemon/lifecycle.js";
import { resultSchema } from "../src/shared/core.js";
import { snapshotUpdateSchema } from "../src/shared/snapshot.js";
import { agentConnectionsStatusSchema } from "../src/shared/agent-connections.js";

await test("CLI owns standalone execution, duplicate start admission and bounded authenticated cleanup", async () => {
  // Owner: real CLI processes, OS lease, HTTP, SQLite and Pi SDK; only provider SSE is a fixture.
  const directory = await mkdtemp(join(tmpdir(), "aster-cli-contract-"));
  const model = await piModelServer();
  try {
    const launch = {
      executable: process.execPath,
      script: resolve("node_modules/@aster/cli/dist/cli/main.js"),
    };
    const [first, second] = await Promise.all([
      ensureDaemon(directory, launch),
      ensureDaemon(directory, launch),
    ]);
    assert.equal(first.pid, second.pid);
    assert.equal(first.kind, "daemon");
    assert.equal((await daemonStatus(directory))?.pid, first.pid);
    const unauthenticated = await fetch(
      `http://127.0.0.1:${first.port}/health`,
      { headers: { Authorization: `Bearer ${"0".repeat(64)}` } },
    );
    assert.equal(unauthenticated.status, 401);
    const config = agentConnectionsStatusSchema.parse(
      await daemonCli(directory, "models", { action: "status" }),
    );
    await daemonCli(directory, "models", {
      action: "save",
      revision: config.revision,
      config: {
        defaultAgent: model.connection.id,
        connections: [model.connection],
      },
    });
    const created = resultSchema.parse(
      await daemonCli(directory, "command", {
        id: randomUUID(),
        command: { type: "bot.create", name: "CLI Bot", description: "" },
      }),
    );
    assert.ok(created.conversationId);
    await daemonCli(directory, "models", {
      action: "assign",
      botId: created.id,
      connectionId: model.connection.id,
    });
    const id = randomUUID(),
      command = {
        type: "message.send",
        conversationId: created.conversationId,
        text: "No Desktop exists",
      };
    await daemonCli(directory, "command", { id, command });
    await daemonCli(directory, "command", { id, command });
    let finished = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = snapshotUpdateSchema.parse(
        await callWorker(first, "/snapshot", {
          conversationId: created.conversationId,
        }),
      );
      if (view.changed && view.snapshot.runs.some((r) => r.status === "failed"))
        assert.fail(JSON.stringify(view.snapshot.runs));
      if (
        view.changed &&
        view.snapshot.runs.some((r) => r.status === "completed")
      ) {
        assert.equal(
          view.snapshot.messages.filter((m) => m.role === "user").length,
          1,
        );
        assert.ok(
          view.snapshot.messages.some((m) => m.text.includes("Hello Pi")),
        );
        finished = true;
        break;
      }
      await delay(100);
    }
    assert.ok(finished, "CLI configured task did not finish");
    assert.equal(model.requests.length, 1);
    await daemonCli(directory, "stop");
    assert.equal(await daemonStatus(directory), null);
    await daemonCli(directory, "start");
    const restored = snapshotUpdateSchema.parse(
      await daemonCli(directory, "snapshot", {
        conversationId: created.conversationId,
      }),
    );
    assert.ok(
      restored.changed &&
        restored.snapshot.messages.some((m) => m.text.includes("Hello Pi")),
    );
    assert.equal(
      model.requests.length,
      1,
      "restart must not repeat accepted side effects",
    );
    await stopDaemon(directory);
    assert.equal(await daemonStatus(directory), null);
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        if (await daemonStatus(directory)) await stopDaemon(directory);
      })(),
      model.close(),
    ]);
    if (cleanup.every((result) => result.status === "fulfilled"))
      await rm(directory, { recursive: true, force: true });
    for (const result of cleanup)
      if (result.status === "rejected") throw result.reason;
  }
});
