import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiAgent } from "../src/agent/pi.js";
import { LiveAgent } from "../src/agent/live.js";
import { AgentConnections } from "../src/agent/connections.js";
import { ContextManager } from "../src/chat/context-manager.js";
import { Runtime } from "../src/chat/runtime.js";
import { Store } from "../src/storage/store.js";
import { WorkspaceCommands } from "../src/worker/commands.js";
import { samplePdf } from "./helpers/pdf.js";
import { piModelServer } from "./helpers/pi-model-server.js";

async function until(ready: () => boolean) {
  const signal = AbortSignal.timeout(10000);
  while (!ready()) {
    signal.throwIfAborted();
    await new Promise<void>((accept) => setImmediate(accept));
  }
}

// Owner: commands -> Runtime -> saved configuration -> real Pi SDK -> model wire.
// Existing cancellation coverage stopped at stream closure, without inspecting
// the next request or retaining the cancelled messages in visible history.
for (const retain of [undefined, true, false]) {
  await test(`cancelled context follows the next request's saved preference (${retain ?? "default"})`, async () => {
    const root = resolve(".runtime/test-results");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "cancelled-context-"));
    const home = join(directory, "agent");
    const store = new Store(":memory:");
    const model = await piModelServer((request, send) => {
      if (
        JSON.stringify(request.messages.at(-1)?.content).includes(
          "CANCELLED_REQUEST",
        )
      ) {
        send({ role: "assistant", content: "CANCELLED_PARTIAL" });
        return;
      }
      send({ role: "assistant", content: "COMPLETED_REPLY" });
      send({}, "stop");
    });
    let runtime = new Runtime(
      store,
      new LiveAgent(home),
      join(directory, "workspaces"),
    );
    let commands = new WorkspaceCommands(store, runtime);
    try {
      const bot = commands.execute({
        id: randomUUID(),
        command: { type: "bot.create", name: "Context", description: "" },
      });
      assert.ok(bot.id && bot.conversationId);
      const conversationId = bot.conversationId;
      const settings = new AgentConnections(home);
      await settings.request(
        {
          action: "save",
          revision: settings.status().revision,
          config: {
            defaultAgent: model.connection.id,
            connections: [model.connection],
            botConnections: { [bot.id]: model.connection.id },
          },
        },
        AbortSignal.timeout(5000),
      );
      const send = (text: string) => {
        const run = commands.execute({
          id: randomUUID(),
          command: { type: "message.send", conversationId, text },
        });
        assert.ok(run.id);
        return run.id;
      };
      const completed = send("COMPLETED_REQUEST");
      await until(() => store.runs.getRun(completed)?.status === "completed");
      const cancelled = send("CANCELLED_REQUEST");
      await until(() =>
        store.views
          .snapshot({ conversationId })
          .messages.some((message) => message.text === "CANCELLED_PARTIAL"),
      );
      commands.execute({
        id: randomUUID(),
        command: { type: "run.cancel", runId: cancelled },
      });
      await until(() => store.runs.getRun(cancelled)?.status === "cancelled");
      commands.stop();
      await runtime.stop();
      // A change after cancellation must apply to the next request, including
      // after reloading the agent and its persisted Pi session.
      if (retain !== undefined) {
        const current = settings.status();
        await settings.request(
          {
            action: "save",
            revision: current.revision,
            config: { ...current.config, retainCancelledContext: retain },
          },
          AbortSignal.timeout(5000),
        );
      }
      runtime = new Runtime(
        store,
        new LiveAgent(home),
        join(directory, "workspaces"),
      );
      commands = new WorkspaceCommands(store, runtime);
      const next = send("NEXT_REQUEST");
      await until(() => store.runs.getRun(next)?.status === "completed");
      const wire = JSON.stringify(model.requests[2]?.messages);
      assert.ok(wire.includes("COMPLETED_REQUEST"));
      assert.ok(wire.includes("COMPLETED_REPLY"));
      assert.ok(wire.includes("NEXT_REQUEST"));
      assert.equal(wire.includes("CANCELLED_REQUEST"), retain !== false);
      if (retain === false) assert.ok(!wire.includes("CANCELLED_PARTIAL"));
      const history = store.views.snapshot({ conversationId }).messages;
      assert.ok(
        history.some((message) => message.text === "CANCELLED_REQUEST"),
      );
      assert.ok(
        history.some((message) => message.text === "CANCELLED_PARTIAL"),
      );
      // Reload again so exclusion cannot be only an in-memory leaf change.
      commands.stop();
      await runtime.stop();
      runtime = new Runtime(
        store,
        new LiveAgent(home),
        join(directory, "workspaces"),
      );
      commands = new WorkspaceCommands(store, runtime);
      const following = send("FOLLOWING_REQUEST");
      await until(() => store.runs.getRun(following)?.status === "completed");
      const followup = JSON.stringify(model.requests[3]?.messages);
      assert.ok(followup.includes("COMPLETED_REQUEST"));
      assert.ok(followup.includes("NEXT_REQUEST"));
      assert.equal(followup.includes("CANCELLED_REQUEST"), retain !== false);
      assert.equal(
        model.requests.length,
        4,
        "cancelled work is never replayed",
      );
    } finally {
      commands.stop();
      await runtime.stop();
      await model.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const retain of [true, false]) {
  await test(`cancelled group discussion context is retained=${retain} for completed and interrupted members`, async () => {
    const root = resolve(".runtime/test-results");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "cancelled-group-"));
    const home = join(directory, "agent");
    const store = new Store(":memory:");
    let calls = 0;
    const model = await piModelServer((_request, send) => {
      calls++;
      let content = `COMPLETED_GROUP_REPLY_${calls}`;
      if (calls === 5 || calls === 6)
        content = "CANCELLED_GROUP_COMPLETED_MEMBER";
      else if (calls === 7) content = "CANCELLED_GROUP_PARTIAL";
      send({ role: "assistant", content });
      if (calls !== 7) send({}, "stop");
    });
    const runtime = new Runtime(
      store,
      new LiveAgent(home),
      join(directory, "workspaces"),
    );
    const commands = new WorkspaceCommands(store, runtime);
    try {
      const bots = ["A", "B"].map((name) => {
        const bot = commands.execute({
          id: randomUUID(),
          command: { type: "bot.create", name, description: "" },
        });
        assert.ok(bot.id);
        return bot.id;
      });
      const settings = new AgentConnections(home);
      await settings.request(
        {
          action: "save",
          revision: settings.status().revision,
          config: {
            defaultAgent: model.connection.id,
            connections: [model.connection],
            botConnections: Object.fromEntries(
              bots.map((id) => [id, model.connection.id]),
            ),
            retainCancelledContext: retain,
          },
        },
        AbortSignal.timeout(5000),
      );
      const group = commands.execute({
        id: randomUUID(),
        command: {
          type: "group.start",
          memberIds: bots,
          text: "COMPLETED_GROUP_REQUEST",
        },
      });
      assert.ok(group.id && group.conversationId);
      const conversationId = group.conversationId;
      const groupId = group.id;
      await until(() => store.runs.getRun(groupId)?.status === "completed");
      const cancelled = commands.execute({
        id: randomUUID(),
        command: {
          type: "message.send",
          conversationId,
          text: "CANCELLED_GROUP_REQUEST",
        },
      });
      assert.ok(cancelled.id);
      const cancelledId = cancelled.id;
      await until(() =>
        store.views
          .snapshot({ conversationId })
          .messages.some(
            (message) => message.text === "CANCELLED_GROUP_PARTIAL",
          ),
      );
      commands.execute({
        id: randomUUID(),
        command: { type: "run.cancel", runId: cancelledId },
      });
      await until(() => store.runs.getRun(cancelledId)?.status === "cancelled");
      const next = commands.execute({
        id: randomUUID(),
        command: {
          type: "message.send",
          conversationId,
          text: "NEXT_GROUP_REQUEST",
        },
      });
      assert.ok(next.id);
      const nextId = next.id;
      await until(() => store.runs.getRun(nextId)?.status === "completed");
      assert.equal(model.requests.length, 11);
      for (const request of model.requests.slice(7)) {
        const wire = JSON.stringify(request.messages);
        assert.ok(wire.includes("COMPLETED_GROUP_REQUEST"));
        for (let ordinal = 1; ordinal <= 4; ordinal++)
          assert.ok(wire.includes(`COMPLETED_GROUP_REPLY_${ordinal}`));
        assert.ok(wire.includes("NEXT_GROUP_REQUEST"));
        assert.equal(wire.includes("CANCELLED_GROUP_REQUEST"), retain);
        assert.equal(wire.includes("CANCELLED_GROUP_COMPLETED_MEMBER"), retain);
        if (!retain) assert.ok(!wire.includes("CANCELLED_GROUP_PARTIAL"));
      }
      assert.ok(
        store.views
          .snapshot({ conversationId })
          .messages.some(
            (message) => message.text === "CANCELLED_GROUP_COMPLETED_MEMBER",
          ),
      );
    } finally {
      commands.stop();
      await runtime.stop();
      await model.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

await test("context preparation hands off current inputs and history without compacting or rotating Pi", async () => {
  const store = new Store(":memory:");
  try {
    const created = store.execute({
      id: randomUUID(),
      command: { type: "bot.create", name: "A", description: "" },
    });
    assert.ok(created.conversationId);
    store.execute({
      id: randomUUID(),
      command: {
        type: "message.send",
        conversationId: created.conversationId,
        text: "continue",
      },
    });
    const job = store.runs.claim();
    assert.ok(job);
    const manager = new ContextManager(store);
    const input = await manager.prepare(
      job,
      "pi-thread",
      () => "current catalog",
      () => "current grants",
      "/workspace",
      AbortSignal.timeout(1000),
      false,
    );
    assert.equal(input.restartThread, false);
    assert.equal(input.text, "current catalog");
    assert.equal(input.rules, "current grants");
    assert.equal(input.context, "");
    const migrated = await manager.prepare(
      job,
      "legacy",
      "continue",
      "",
      "/workspace",
      AbortSignal.timeout(1000),
      false,
      true,
    );
    assert.equal(migrated.restartThread, true);
  } finally {
    store.close();
  }
});

await test("runtime budgets document metadata against the selected model and rejects oversized prompts before inference", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "context-"));
  const store = new Store(":memory:");
  const model = await piModelServer();
  const text = "界".repeat(24000);
  const pdf = samplePdf("DOCUMENT_CONTENT", "scan");
  try {
    for (const contextWindow of [128000, 8192]) {
      const runtime = new Runtime(
        store,
        new PiAgent(join(directory, "agent"), {
          ...model.connection,
          contextWindow,
          maxTokens: 1024,
        }),
        join(directory, "workspaces"),
      );
      try {
        const bot = store.execute({
          id: randomUUID(),
          command: { type: "bot.create", name: "Budget", description: "" },
        });
        assert.ok(bot.conversationId);
        const conversationId = bot.conversationId;
        const attachments = Array.from({ length: 8 }, (_, index) =>
          store.files.registerAttachment(
            { id: randomUUID(), conversationId, name: `input-${index}.pdf` },
            pdf,
          ),
        );
        const run = store.execute({
          id: randomUUID(),
          command: {
            type: "message.send",
            conversationId,
            text,
            attachmentIds: attachments.map((attachment) => attachment.id),
          },
        });
        assert.ok(run.id);
        runtime.wake();
        const signal = AbortSignal.timeout(10000);
        while (
          ["queued", "running"].includes(
            store.runs.getRun(run.id)?.status ?? "",
          )
        ) {
          signal.throwIfAborted();
          await new Promise<void>((accept) => setImmediate(accept));
        }
        const finished = store.runs.getRun(run.id);
        assert.equal(
          finished?.status,
          contextWindow === 128000 ? "completed" : "failed",
          finished?.error ?? undefined,
        );
        if (contextWindow === 8192)
          assert.match(finished?.error ?? "", /所选模型的输入预算/);
      } finally {
        await runtime.stop();
      }
    }
    assert.equal(model.requests.length, 1);
    const prompt = JSON.stringify(model.requests[0]?.messages);
    assert.ok(prompt.includes(text));
    for (let index = 0; index < 8; index++)
      assert.ok(prompt.includes(`input-${index}.pdf`));
    assert.ok(!prompt.includes("DOCUMENT_CONTENT"));
  } finally {
    await model.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
