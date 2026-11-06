import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent, AgentInput, AgentResult } from "../src/chat/agent.js";
import { Runtime } from "../src/chat/runtime.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import type { StructuredModel } from "../src/shared/memory.js";

class ControlledAgent implements Agent {
  started: Promise<AgentInput>;
  private notify: (input: AgentInput) => void = () => {};
  complete: (result: AgentResult) => void = () => {};
  constructor() {
    this.started = new Promise((resolve) => {
      this.notify = resolve;
    });
  }
  check() {
    return Promise.resolve({ accountType: "test", detail: "test fixture" });
  }
  run(input: AgentInput) {
    this.notify(input);
    return new Promise<AgentResult>((resolve) => {
      this.complete = resolve;
    });
  }
}
await test("cancellation waits for the Agent acknowledgement; close waits for owned work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-"));
  const store = new Store(join(directory, "db.sqlite"));
  const agent = new ControlledAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const command = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const conversationId = command({
      type: "bot.create",
      name: "Fixture",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    const runId = command({
      type: "message.send",
      conversationId,
      text: "wait",
    }).id;
    assert.ok(runId);
    const input = await agent.started;
    command({ type: "run.cancel", runId });
    assert.equal(input.signal.aborted, true);
    assert.equal(store.runs.getRun(runId)?.status, "cancelling");
    commands.stop();
    const stopping = runtime.stop();
    agent.complete({ status: "cancelled", error: null });
    await stopping;
    assert.equal(store.runs.getRun(runId)?.status, "cancelled");
    assert.throws(
      () => command({ type: "message.send", conversationId, text: "late" }),
      /停止/,
    );
  } finally {
    agent.complete({ status: "cancelled", error: null });
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("超时取消等待 Agent 的异步清理，停止和同 Bot 后续运行都不能提前完成", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-cleanup-"));
  const store = new Store(join(directory, "db.sqlite"));
  let entered = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runtime = new Runtime(
    store,
    {
      check: async () => ({ accountType: "fixture", detail: "fixture" }),
      run: async (input) => {
        calls++;
        entered();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        await cleanup;
        return { status: "cancelled", error: null };
      },
    },
    join(directory, "workspaces"),
    undefined,
    undefined,
    20,
  );
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute({ id: randomUUID(), command });
  try {
    const bot = execute({
      type: "bot.create",
      name: "Cleanup",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "first",
    });
    assert.ok(sent.id);
    await started;
    t.mock.timers.tick(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      store.runs.getRun(sent.id)?.status,
      "cancelling",
      "清理确认前仍持有执行归属",
    );
    const next = execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "next",
    });
    assert.ok(next.id);
    assert.notEqual(next.id, sent.id, "取消期间的新消息不能并入旧运行");
    assert.equal(store.runs.getRun(next.id)?.status, "queued");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "同 Bot 的后续运行必须等清理完成");
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(store.runs.getRun(sent.id)?.status, "failed");
  } finally {
    release();
    await runtime.stop();
    t.mock.timers.reset();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class SequencingAgent implements Agent {
  readonly inputs: AgentInput[] = [];
  private arrival: (input: AgentInput) => void = () => {};
  private arrived = new Promise<AgentInput>((resolve) => {
    this.arrival = resolve;
  });
  private pending: Array<(result: AgentResult) => void> = [];
  check() {
    return Promise.resolve({ accountType: "test", detail: "test fixture" });
  }
  run(input: AgentInput) {
    this.inputs.push(input);
    if (this.inputs.length === 1)
      input.onEvent({ type: "thread", threadId: "kept-thread" });
    const resolve = this.arrival;
    this.arrived = new Promise<AgentInput>((next) => {
      this.arrival = next;
    });
    resolve(input);
    return new Promise<AgentResult>((done) => {
      this.pending.push(done);
    });
  }
  complete(result: AgentResult) {
    this.pending.shift()?.(result);
  }
  next() {
    return this.arrived;
  }
}
await test("a steer that arrives while a private run is executing continues on the same thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-steer-"));
  const store = new Store(join(directory, "db.sqlite"));
  const agent = new SequencingAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const command = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const conversationId = command({
      type: "bot.create",
      name: "Fixture",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    const sent = command({
      type: "message.send",
      conversationId,
      text: "alpha",
    });
    assert.ok(sent.id);
    const runId = sent.id;
    const first = await agent.next();
    assert.equal(first.text, "alpha");
    assert.equal(first.threadId, null);
    const steer = command({
      type: "message.send",
      conversationId,
      text: "beta",
    });
    assert.equal(steer.id, runId);
    assert.equal(
      store.views
        .snapshot({ conversationId })
        .runs.filter((run) =>
          ["queued", "running", "cancelling"].includes(run.status),
        ).length,
      1,
    );
    agent.complete({ status: "completed", error: null });
    const second = await agent.next();
    assert.equal(second.text, "beta");
    assert.equal(second.threadId, "kept-thread");
    assert.equal(store.runs.getRun(runId)?.status, "running");
    const stopping = runtime.stop();
    agent.complete({ status: "completed", error: null });
    await stopping;
    assert.equal(store.runs.getRun(runId)?.status, "completed");
    assert.equal(store.views.snapshot({ conversationId }).runs.length, 1);
  } finally {
    agent.complete({ status: "cancelled", error: null });
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a follow-up that arrives after the private turn returns continues on the same thread before completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-steer-late-"));
  const store = new Store(join(directory, "db.sqlite"));
  const agent = new SequencingAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const command = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const conversationId = command({
      type: "bot.create",
      name: "Fixture",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    const sent = command({
      type: "message.send",
      conversationId,
      text: "alpha",
    });
    assert.ok(sent.id);
    const runId = sent.id;
    const first = await agent.next();
    assert.equal(first.text, "alpha");
    assert.equal(first.threadId, null);
    agent.complete({ status: "completed", error: null });
    queueMicrotask(() => {
      const steer = command({
        type: "message.send",
        conversationId,
        text: "beta",
      });
      assert.equal(steer.id, runId);
    });
    const second = await Promise.race([
      agent.next(),
      new Promise<AgentInput>((_, reject) => {
        setTimeout(
          () => reject(new Error("追加指令没有在完成前进入同一线程。")),
          1000,
        );
      }),
    ]);
    assert.equal(second.text, "beta");
    assert.equal(second.threadId, "kept-thread");
    assert.equal(store.runs.getRun(runId)?.status, "running");
    assert.equal(store.views.snapshot({ conversationId }).runs.length, 1);
    agent.complete({ status: "completed", error: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.runs.getRun(runId)?.status, "completed");
    assert.equal(store.runs.claim(), undefined);
    assert.equal(store.views.snapshot({ conversationId }).runs.length, 1);
  } finally {
    agent.complete({ status: "cancelled", error: null });
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("runtime leaves compaction to Pi and never rotates or replays a completed task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-context-runtime-"));
  const store = new Store(join(directory, "db.sqlite"));
  const inputs: AgentInput[] = [];
  let summaries = 0;
  const agent: Agent & StructuredModel = {
    async check() {
      return { accountType: "test", detail: "test" };
    },
    async generate() {
      summaries++;
      throw Error("The application must not perform Pi's context compaction");
    },
    async run(input) {
      inputs.push(input);
      input.onEvent({ type: "thread", threadId: `thread-${inputs.length}` });
      input.onEvent({
        type: "text",
        itemId: "reply",
        text: "completed",
        complete: true,
      });
      input.onEvent({
        type: "context-usage",
        usage: {
          usedTokens: inputs.length === 1 ? 50000 : 1000,
          contextWindow: 64000,
        },
      });
      return { status: "completed", error: null };
    },
  };
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const created = execute({ type: "bot.create", name: "A", description: "" });
    assert.ok(created.conversationId);
    for (const text of ["first task", "second task", "third task"]) {
      const run = execute({
        type: "message.send",
        conversationId: created.conversationId,
        text,
      });
      assert.ok(run.id);
      const deadline = Date.now() + 5000;
      while (
        store.runs.getRun(run.id)?.status !== "completed" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(store.runs.getRun(run.id)?.status, "completed");
    }
    assert.deepEqual(
      inputs.map((input) => input.text),
      ["first task", "second task", "third task"],
    );
    assert.equal(inputs[1]?.restartThread, false);
    assert.equal(inputs[1]?.threadId, "thread-1");
    assert.doesNotMatch(
      inputs[1]?.instructions ?? "",
      /Previous conversation summary/,
    );
    assert.equal(inputs[2]?.threadId, "thread-2");
    assert.doesNotMatch(
      inputs[2]?.instructions ?? "",
      /Previous conversation summary/,
    );
    assert.equal(summaries, 0);
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a deadline is recorded as failed only after the Agent settles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-deadline-"));
  const store = new Store(join(directory, "db.sqlite"));
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = new Runtime(
    store,
    {
      check: async () => ({ accountType: "fixture", detail: "fixture" }),
      run: async () => {
        entered();
        return new Promise<AgentResult>((resolve) => {
          setTimeout(() => resolve({ status: "cancelled", error: null }), 200);
        });
      },
    },
    join(directory, "workspaces"),
    undefined,
    undefined,
    20,
  );
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const conversationId = execute({
      type: "bot.create",
      name: "Deadline",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = execute({
      type: "message.send",
      conversationId,
      text: "too long",
    });
    assert.ok(sent.id);
    await started;
    t.mock.timers.tick(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.runs.getRun(sent.id)?.status, "cancelling");
    t.mock.timers.tick(200);
    await runtime.stop();
    assert.equal(store.runs.getRun(sent.id)?.status, "failed");
    assert.match(store.runs.getRun(sent.id)?.error ?? "", /时限/);
  } finally {
    t.mock.timers.tick(200);
    await runtime.stop();
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.reset();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a group deadline is failed, not cancelled, and releases its lane", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "aster-runtime-group-deadline-"),
  );
  const store = new Store(join(directory, "db.sqlite"));
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete: (result: AgentResult) => void = () => {};
  const runtime = new Runtime(
    store,
    {
      check: async () => ({ accountType: "fixture", detail: "fixture" }),
      run: async () => {
        entered();
        return new Promise<AgentResult>((resolve) => {
          complete = resolve;
        });
      },
    },
    join(directory, "workspaces"),
    undefined,
    undefined,
    20,
  );
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const first = execute({ type: "bot.create", name: "A", description: "" });
    const second = execute({ type: "bot.create", name: "B", description: "" });
    assert.ok(first.id && second.id);
    // Start the deadline clock after filesystem setup reaches the Agent.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const group = execute({
      type: "group.start",
      memberIds: [first.id, second.id],
      text: "discuss",
    });
    assert.ok(group.id);
    await started;
    t.mock.timers.tick(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.runs.getRun(group.id)?.status, "cancelling");
    complete({ status: "cancelled", error: null });
    await runtime.stop();
    assert.equal(store.runs.getRun(group.id)?.status, "failed");
    assert.match(store.runs.getRun(group.id)?.error ?? "", /时限/);
  } finally {
    complete({ status: "cancelled", error: null });
    await runtime.stop();
    t.mock.timers.reset();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("an Agent that returns after the deadline cannot rewrite the timed-out run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-runtime-late-"));
  const store = new Store(join(directory, "db.sqlite"));
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resolveLate: (result: AgentResult) => void = () => {};
  let lateEvent: (() => void) | undefined;
  const runtime = new Runtime(
    store,
    {
      check: async () => ({ accountType: "fixture", detail: "fixture" }),
      run: async (input) => {
        entered();
        lateEvent = () =>
          input.onEvent({
            type: "text",
            itemId: "late",
            text: "after".repeat(1000),
            complete: true,
          });
        return new Promise<AgentResult>((resolve) => {
          resolveLate = resolve;
        });
      },
    },
    join(directory, "workspaces"),
    undefined,
    undefined,
    20,
  );
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) =>
    commands.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const conversationId = execute({
      type: "bot.create",
      name: "Late",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = execute({
      type: "message.send",
      conversationId,
      text: "late",
    });
    assert.ok(sent.id);
    await started;
    t.mock.timers.tick(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.runs.getRun(sent.id)?.status, "cancelling");
    const writes = t.mock.method(store.runs.output, "writeStream");
    const before = store.views.snapshot({ conversationId }).messages.length;
    assert.ok(lateEvent);
    lateEvent();
    resolveLate({ status: "completed", error: null });
    await runtime.stop();
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(store.runs.getRun(sent.id)?.status, "failed");
    assert.equal(
      store.views.snapshot({ conversationId }).messages.length,
      before,
    );
    await runtime.stop();
  } finally {
    resolveLate({ status: "cancelled", error: null });
    await runtime.stop();
    t.mock.timers.reset();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
