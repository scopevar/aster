import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Runtime } from "../src/chat/runtime.js";
import type { AgentInput, AgentResult } from "../src/chat/agent.js";
import type { Command } from "../src/shared/commands.js";

await test("two Bot lanes progress independently, serialize the same Bot, and drain cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-runtime-lanes-"));
  const store = new Store(join(dir, "db.sqlite"));
  const running = new Map<string, { input: AgentInput; finish(): void }>();
  let active = 0,
    peak = 0;
  const runtime = new Runtime(
    store,
    {
      check: async () => ({ accountType: "fixture", detail: "fixture" }),
      run: async (input) => {
        active++;
        peak = Math.max(peak, active);
        try {
          return await new Promise<AgentResult>((resolve) => {
            const finish = () =>
              resolve({
                status: input.signal.aborted ? "cancelled" : "completed",
                error: null,
              });
            running.set(input.text, { input, finish });
            if (input.signal.aborted) finish();
            else input.signal.addEventListener("abort", finish, { once: true });
          });
        } finally {
          active--;
          running.delete(input.text);
        }
      },
    },
    join(dir, "workspaces"),
  );
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute({ id: randomUUID(), command });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "runtime did not progress");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const a = execute({ type: "bot.create", name: "a", description: "" });
    const b = execute({ type: "bot.create", name: "b", description: "" });
    assert.ok(a.id && a.conversationId && b.conversationId);
    const a2 = execute({ type: "conversation.create", botId: a.id });
    assert.ok(a2.conversationId);
    const first = execute({
      type: "message.send",
      conversationId: a.conversationId,
      text: "a1",
    });
    assert.ok(first.id);
    execute({
      type: "message.send",
      conversationId: a2.conversationId,
      text: "a2",
    });
    const second = execute({
      type: "message.send",
      conversationId: b.conversationId,
      text: "b1",
    });
    assert.ok(second.id);
    await wait(() => running.has("a1") && running.has("b1"));
    assert.equal(running.has("a2"), false);
    execute({ type: "run.cancel", runId: second.id });
    await wait(() => store.runs.getRun(second.id!)?.status === "cancelled");
    assert.equal(running.get("a1")?.input.signal.aborted, false);
    running.get("a1")?.finish();
    await wait(() => running.has("a2"));
    await runtime.stop();
    assert.equal(active, 0);
    assert.equal(peak, 2);
  } finally {
    for (const task of running.values()) task.finish();
    await runtime.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("a queued group is an exclusive fairness barrier between private Bot runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-group-lanes-"));
  const store = new Store(join(dir, "db.sqlite"));
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  try {
    const a = execute({ type: "bot.create", name: "a", description: "" });
    const b = execute({ type: "bot.create", name: "b", description: "" });
    assert.ok(a.id && a.conversationId && b.id && b.conversationId);
    execute({
      type: "message.send",
      conversationId: a.conversationId,
      text: "first",
    });
    const first = store.runs.claim();
    assert.ok(first);
    const group = execute({
      type: "group.start",
      memberIds: [a.id, b.id],
      text: "group",
    });
    assert.ok(group.id);
    execute({
      type: "message.send",
      conversationId: b.conversationId,
      text: "after group",
    });
    assert.equal(store.runs.claim(), undefined);
    store.runs.finish(first.id, "completed", null);
    const groupJob = store.runs.claim();
    assert.equal(groupJob?.id, group.id);
    assert.equal(store.runs.claim(), undefined);
    store.runs.finish(group.id, "cancelled", null);
    assert.equal(store.runs.claim()?.botId, b.id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
