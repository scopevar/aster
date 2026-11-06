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
import { localProjectId } from "../src/shared/memory.js";
import { Store } from "../src/storage/store.js";

const req = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });

class WaitingAgent implements Agent {
  started: Promise<AgentInput>;
  complete: (result: AgentResult) => void = () => {};
  private notify: (input: AgentInput) => void = () => {};
  constructor() {
    this.started = new Promise((resolve) => {
      this.notify = resolve;
    });
  }
  check() {
    return Promise.resolve({ accountType: "test", detail: "fixture" });
  }
  run(input: AgentInput) {
    this.notify(input);
    return new Promise<AgentResult>((resolve) => {
      this.complete = resolve;
    });
  }
}

await test("account and project memory stay outside one bot's memory and the chat transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-shared-memory-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const agent = new WaitingAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const execute = (command: Command) => store.execute(req(command));
  try {
    const first = execute({
      type: "bot.create",
      name: "私有",
      description: "",
    });
    const second = execute({
      type: "bot.create",
      name: "另一",
      description: "",
    });
    assert.ok(first.id && first.conversationId);
    assert.ok(second.id && second.conversationId);
    const privateId = randomUUID();
    execute({
      type: "memory.save",
      scope: { botId: first.id, conversationId: null },
      id: privateId,
      revision: 0,
      topic: "私有主题",
      content: "ONLY-A",
    });
    const accountId = randomUUID();
    const accountSave = req({
      type: "memory.shared.save",
      scope: { kind: "account" },
      id: accountId,
      revision: 0,
      topic: "账户主题",
      content: "ACCOUNT-FACT",
    });
    store.execute(accountSave);
    store.execute(accountSave);
    const projectId = randomUUID();
    execute({
      type: "memory.shared.save",
      scope: { kind: "project", projectId: localProjectId },
      id: projectId,
      revision: 0,
      topic: "项目主题",
      content: "PROJECT-FACT",
    });
    execute({
      type: "memory.shared.save",
      scope: { kind: "project", projectId: "other" },
      id: randomUUID(),
      revision: 0,
      topic: "其他项目",
      content: "OTHER-PROJECT",
    });
    const account = store.memoryOperations.sharedMemoryView({
      kind: "account",
    });
    assert.equal(account.entries.length, 1);
    assert.equal(account.entries[0]?.revision, 1);
    assert.equal(account.entries[0]?.content, "ACCOUNT-FACT");
    assert.equal(
      store.memoryOperations.sharedMemoryView({
        kind: "project",
        projectId: localProjectId,
      }).entries[0]?.content,
      "PROJECT-FACT",
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({
        kind: "project",
        projectId: "other",
      }).entries[0]?.content,
      "OTHER-PROJECT",
    );
    const owned = store.memoryOperations.memoryView({
      botId: first.id,
      conversationId: null,
    });
    assert.deepEqual(
      owned.entries.map((entry) => entry.content),
      ["ONLY-A"],
    );
    assert.equal(
      store.memoryOperations.memoryView({
        botId: second.id,
        conversationId: null,
      }).entries.length,
      0,
    );
    assert.throws(
      () =>
        execute({
          type: "memory.shared.save",
          scope: { kind: "account" },
          id: randomUUID(),
          revision: 0,
          topic: "账户主题",
          content: "另一条",
        }),
      /同主题共享记忆已存在/,
    );
    assert.throws(
      () =>
        execute({
          type: "memory.shared.save",
          scope: { kind: "account" },
          id: accountId,
          revision: 0,
          topic: "账户主题",
          content: "过期内容",
        }),
      /共享记忆已改变/,
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries[0]
        ?.content,
      "ACCOUNT-FACT",
    );
    execute({
      type: "memory.shared.save",
      scope: { kind: "account" },
      id: accountId,
      revision: 1,
      topic: "账户主题",
      content: "ACCOUNT-FACT-2",
    });
    const runId = commands.execute(
      req({
        type: "message.send",
        conversationId: second.conversationId,
        text: "hello-chat",
      }),
    ).id;
    assert.ok(runId);
    const input = await agent.started;
    const privateAt = input.instructions.indexOf("长期记忆");
    const accountAt = input.instructions.indexOf("账户共享记忆");
    const projectAt = input.instructions.indexOf("本地项目共享记忆");
    assert.ok(privateAt >= 0 && accountAt > privateAt && projectAt > accountAt);
    assert.match(input.instructions, /ACCOUNT-FACT-2/);
    assert.match(input.instructions, /PROJECT-FACT/);
    assert.doesNotMatch(input.instructions, /ONLY-A/);
    assert.doesNotMatch(input.instructions, /OTHER-PROJECT/);
    agent.complete({ status: "completed", error: null });
    await runtime.stop();
    assert.equal(store.runs.getRun(runId)?.status, "completed");
    const texts = store.views
      .snapshot({ conversationId: second.conversationId })
      .messages.map((message) => message.text);
    assert.ok(texts.includes("hello-chat"));
    assert.equal(
      texts.some((text) => text.includes("ACCOUNT-FACT")),
      false,
    );
    execute({
      type: "memory.shared.forget",
      scope: { kind: "account" },
      id: accountId,
      revision: 2,
    });
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries
        .length,
      0,
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({
        kind: "project",
        projectId: localProjectId,
      }).entries[0]?.content,
      "PROJECT-FACT",
    );
    assert.ok(
      store.views
        .snapshot({ conversationId: second.conversationId })
        .messages.some((message) => message.text === "hello-chat"),
    );
    execute({
      type: "memory.auto",
      scope: { botId: second.id, conversationId: null },
      revision: 0,
      enabled: true,
    });
    execute({
      type: "message.send",
      conversationId: second.conversationId,
      text: "chat-only-sentence",
    });
    const follow = store.runs.claim();
    assert.ok(follow);
    store.runs.finish(follow.id, "completed", null);
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries
        .length,
      0,
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({
        kind: "project",
        projectId: localProjectId,
      }).entries.length,
      1,
    );
    assert.ok(
      store.memoryOperations
        .memoryView({ botId: second.id, conversationId: null })
        .jobs.some((job) => job.status === "queued" || job.status === "failed"),
    );
    const context = store.memoryOperations.memoryContext(follow);
    assert.match(context, /当前没有可检索的条目/);
    assert.match(context, /PROJECT-FACT/);
    assert.doesNotMatch(context, /ACCOUNT-FACT/);
    assert.doesNotMatch(context, /ONLY-A/);
    assert.doesNotMatch(context, /chat-only-sentence/);
    const restored = randomUUID();
    execute({
      type: "memory.shared.save",
      scope: { kind: "account" },
      id: restored,
      revision: 0,
      topic: "账户主题",
      content: "ACCOUNT-RESTORED",
    });
    assert.throws(
      () =>
        execute({
          type: "memory.shared.forget",
          scope: { kind: "account" },
          id: restored,
          revision: 2,
        }),
      /共享记忆已改变/,
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries[0]
        ?.content,
      "ACCOUNT-RESTORED",
    );
    store.close();
    store = new Store(path);
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries[0]
        ?.content,
      "ACCOUNT-RESTORED",
    );
    assert.equal(
      store.memoryOperations.memoryView({
        botId: first.id,
        conversationId: null,
      }).entries[0]?.content,
      "ONLY-A",
    );
  } finally {
    agent.complete({ status: "cancelled", error: null });
    await runtime.stop();
    try {
      store.close();
    } catch {
      // The success path already closed this handle before reopening the file.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a shared scope reports its own capacity without discarding entries", () => {
  const store = new Store(":memory:");
  try {
    for (let index = 0; index < 200; index++)
      store.execute(
        req({
          type: "memory.shared.save",
          scope: { kind: "project", projectId: "cap" },
          id: randomUUID(),
          revision: 0,
          topic: `主题${index}`,
          content: `内容${index}`,
        }),
      );
    assert.equal(
      store.memoryOperations.sharedMemoryView({
        kind: "project",
        projectId: "cap",
      }).entries.length,
      200,
    );
    assert.throws(
      () =>
        store.execute(
          req({
            type: "memory.shared.save",
            scope: { kind: "project", projectId: "cap" },
            id: randomUUID(),
            revision: 0,
            topic: "超出",
            content: "不会写入",
          }),
        ),
      /200 条/,
    );
    assert.equal(
      store.memoryOperations.sharedMemoryView({ kind: "account" }).entries
        .length,
      0,
    );
  } finally {
    store.close();
  }
});
