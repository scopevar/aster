import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { commandSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";
import { callWorker } from "../src/worker/client.js";
import { startWorker } from "../src/worker/server.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

// The real Worker owns retirement: old data remains readable, but no desktop
// command, HTTP endpoint or pending approval can reactivate the old environment.
await test("retired computer data stays readable while execution and cleanup use only the current environment", async () => {
  const results = resolve(".runtime/test-results");
  await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(results, "retired-computer-"));
  const data = localWorkspaceDirectory(root);
  await mkdir(data, { recursive: true });
  const database = join(data, "aster.sqlite");
  const store = new Store(database);
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  const bot = execute({ type: "bot.create", name: "Legacy", description: "" });
  assert.ok(bot.id && bot.conversationId);
  execute({
    type: "message.send",
    conversationId: bot.conversationId,
    text: "Previous desktop task",
  });
  const job = store.runs.claim();
  assert.ok(job);
  const old = store.toolOperations.toolRequest(job, "previous-call", {
    type: "script",
    command: "true",
    network: [],
  });
  store.close();
  const legacy = new DatabaseSync(database);
  try {
    legacy
      .prepare("UPDATE computer_calls SET actionJson=? WHERE id=?")
      .run(JSON.stringify({ type: "screenshot" }), old.id);
    legacy
      .prepare(
        "INSERT INTO computers VALUES(?,1,1,'starting','none',1,'previous desktop')",
      )
      .run(bot.id);
  } finally {
    legacy.close();
  }
  const workspace = join(data, "workspaces", bot.id, "script-work");
  await mkdir(workspace, { recursive: true });
  const file = join(workspace, "result.txt");
  await writeFile(file, "Microsandbox work file");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker(root, { port: 0 });
    const endpoint = worker.endpoint;
    const snapshot = await workerSnapshot(endpoint, {
      conversationId: bot.conversationId,
    });
    const history = snapshot.messages.find(
      (message) => message.computerTool?.id === old.id,
    );
    assert.equal(history?.computerTool?.action.type, "screenshot");
    assert.equal(history?.computerTool?.status, "cancelled");
    await access(file);
    for (const [path, input] of [
      [`/computer/state?botId=${bot.id}`, undefined],
      ["/computer/image", undefined],
      ["/computer/image", { action: "download" }],
      ["/computer/connect", { botId: bot.id }],
      ["/computer/text", { text: "old input" }],
      ["/recording", { action: "status", botId: bot.id }],
      ["/approval", { action: "status" }],
      ["/tools/call", { callId: "old-tool", action: { type: "screenshot" } }],
    ] as const) {
      await assert.rejects(
        callWorker(endpoint, path, input),
        { code: "not_found" },
        path,
      );
    }
    for (const type of [
      "start",
      "stop",
      "control",
      "snapshot",
      "recover",
      "reset",
      "restoreBrowser",
      "restoreApps",
      "installApp",
      "file",
      "command",
      "teach",
    ])
      assert.equal(
        commandSchema.safeParse({
          type: `computer.${type}`,
          botId: bot.id,
          revision: 0,
        }).success,
        false,
        type,
      );
    await assert.rejects(
      callWorker(endpoint, "/command", {
        id: randomUUID(),
        command: {
          type: "tool.decide",
          id: old.id,
          conversationId: bot.conversationId,
          decision: "allow",
        },
      }),
      { code: "conflict" },
    );
    await callWorker(endpoint, "/command", {
      id: randomUUID(),
      command: {
        type: "entity.delete",
        kind: "bot",
        targetId: bot.id,
        expectedName: "Legacy",
      },
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        (await workerSnapshot(endpoint)).bots.find((item) => item.id === bot.id)
          ?.lifecycle === "deleted"
      )
        break;
      await delay(10);
    }
    assert.equal(
      (await workerSnapshot(endpoint)).bots.find((item) => item.id === bot.id)
        ?.lifecycle,
      "deleted",
    );
    await assert.rejects(access(file), { code: "ENOENT" });
  } finally {
    await worker?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
