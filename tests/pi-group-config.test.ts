import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "../src/chat/agent.js";
import { Runtime } from "../src/chat/runtime.js";
import { Store } from "../src/storage/store.js";

await test("group turns capture each Bot's current configuration without changing an active turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-group-config-"));
  const store = new Store(join(root, "aster.sqlite"));
  let version = 1,
    turns = 0;
  const versions: number[] = [];
  const members: string[] = [];
  const agent: Agent = {
    async check() {
      return { accountType: null, detail: "" };
    },
    async run() {
      throw Error("Runtime must use the captured configuration");
    },
    capture(botId) {
      assert.ok(botId);
      const captured = version;
      return {
        async check() {
          return { accountType: null, detail: "" };
        },
        async run(input) {
          assert.equal(input.sessionScope?.botId, botId);
          members.push(botId);
          version = 2;
          versions.push(captured);
          if (++turns <= 2)
            input.onEvent({
              type: "text",
              itemId: "reply",
              text: "member reply",
              complete: true,
            });
          return { status: "completed", error: null };
        },
      };
    },
  };
  const runtime = new Runtime(store, agent, join(root, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  try {
    const execute = (command: Parameters<Store["execute"]>[0]["command"]) =>
      commands.execute({ id: randomUUID(), command });
    const first = execute({ type: "bot.create", name: "A", description: "" });
    const second = execute({ type: "bot.create", name: "B", description: "" });
    assert.ok(first.id);
    assert.ok(second.id);
    const run = execute({
      type: "group.start",
      memberIds: [first.id, second.id],
      text: "discuss",
    });
    assert.ok(run.id);
    const deadline = Date.now() + 5000;
    while (
      store.runs.getRun(run.id)?.status !== "completed" &&
      Date.now() < deadline
    )
      await delay(10);
    assert.equal(store.runs.getRun(run.id)?.status, "completed");
    assert.deepEqual(new Set(members), new Set([first.id, second.id]));
    assert.deepEqual(versions, [1, 2, 2, 2]);
  } finally {
    await runtime.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
