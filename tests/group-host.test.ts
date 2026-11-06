import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../src/chat/runtime.js";
import { HostJudge } from "../src/chat/group-judge.js";
import { JevClient } from "../src/agent/jev.js";
import { Store } from "../src/storage/store.js";
import { purgeConversation } from "../src/storage/chat/conversation-purge.js";
import type { Agent, AgentInput } from "../src/chat/agent.js";
import type { Command } from "../src/shared/commands.js";
import {
  groupTurnLimit,
  type GroupHostState,
} from "../src/shared/chat/group-host.js";
import { jevAnswer, jevServer } from "./helpers/jev-server.js";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), "expected group execution to reach its observable state");
}

async function fixture(
  run: (input: AgentInput) => Promise<void> = async (input) => {
    input.onEvent({
      type: "text",
      itemId: "reply",
      text: "已实际完成当前职责",
      complete: true,
    });
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "aster-hosted-group-"));
  const store = new Store(join(directory, "aster.sqlite"));
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  const host = execute({
    type: "bot.create",
    name: "主持人",
    description: "负责规划、协调、验证与收尾",
  }).id!;
  const worker = execute({
    type: "bot.create",
    name: "执行者",
    description: "负责实现任务",
  }).id!;
  const unused = execute({
    type: "bot.create",
    name: "复核者",
    description: "必要时检查证据",
  }).id!;
  const calls: AgentInput[] = [];
  const agent: Agent = {
    async check() {
      return { accountType: null, detail: "fixture" };
    },
    async run(input) {
      calls.push(input);
      await run(input);
      return { status: "completed", error: null };
    },
  };
  return {
    directory,
    store,
    execute,
    host,
    worker,
    unused,
    calls,
    agent,
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// The owner is Runtime + SQLite + native Jev HTTP: a selected member must execute,
// receive actual prior replies and leave a durable turn; other members must stay idle.
await test("host plans, Jev selects a member, and the host delivers the final result without a fixed second round", async () => {
  const f = await fixture(async (input) => {
    input.onEvent({
      type: "thread",
      threadId: `${input.sessionScope?.botId}-group-thread`,
    });
    input.onEvent({
      type: "text",
      itemId: "reply",
      text: input.instructions.includes("现在负责收尾")
        ? "交付：执行者已返回结果；未执行复核。"
        : "实际结果与分工",
      complete: true,
    });
  });
  const remote = await jevServer((_request, response) =>
    jevAnswer(response, remote.requests.length === 1 ? f.worker : "finish"),
  );
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge(
        {
          async generate() {
            throw Error("confident Jev decisions need no second model call");
          },
        },
        new JevClient(remote.config, "fixture-key"),
      ),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker, f.unused],
        hostBotId: f.host,
        text: "做好本次任务",
      },
    });
    assert.ok(created.id);
    assert.ok(created.conversationId);
    await waitFor(
      () => f.store.runs.getRun(created.id!)?.status === "completed",
    );
    assert.deepEqual(
      f.calls.map((call) => call.sessionScope?.botId),
      [f.host, f.worker, f.host],
    );
    assert.match(f.calls[0]!.instructions, /先理解需求/);
    assert.match(f.calls[1]!.text, /实际结果与分工/);
    assert.match(f.calls[2]!.instructions, /核对成员实际结果与证据/);
    assert.equal(f.calls[2]!.threadId, `${f.host}-group-thread`);
    const messages = f.store.views.snapshot({
      conversationId: created.conversationId,
    }).messages;
    assert.match(messages.at(-1)!.text, /未执行复核/);
    assert.deepEqual(
      f.store.runs.getRun(created.id)?.groupTurns.map((turn) => turn.status),
      ["completed", "completed", "completed"],
    );
    assert.equal(remote.requests.length, 2);
    assert.deepEqual(remote.authorizations, [
      "Bearer fixture-key",
      "Bearer fixture-key",
    ]);
    assert.doesNotMatch(JSON.stringify(remote.requests), /fixture-key/);
  } finally {
    await runtime.stop();
    await remote.close();
    await f.close();
  }
});

await test("a simple answer by the host completes without a second paraphrase", async () => {
  const f = await fixture();
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge({
        async generate() {
          return { choice: "finish" };
        },
      }),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker],
        hostBotId: f.host,
        text: "一个简单问题",
      },
    });
    await waitFor(
      () => f.store.runs.getRun(created.id!)?.status === "completed",
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.runs.getRun(created.id!)?.groupTurns.length, 1);
    assert.equal(
      f.store.views
        .snapshot({ conversationId: created.conversationId })
        .messages.filter((message) => message.role === "assistant").length,
      1,
    );
  } finally {
    await runtime.stop();
    await f.close();
  }
});

await test("a tool-only host turn still gets a visible delivery before completing", async () => {
  const f = await fixture(async (input) => {
    if (input.instructions.includes("现在负责收尾")) {
      input.onEvent({
        type: "text",
        itemId: "summary",
        text: "向用户交付工具结果。",
        complete: true,
      });
      return;
    }
    input.onEvent({
      type: "tool",
      itemId: "inspection",
      tool: {
        kind: "command",
        command: "fixture inspection",
        cwd: "/workspace",
        status: "completed",
        output: "fixture result",
        truncated: false,
        exitCode: 0,
        durationMs: 1,
      },
    });
  });
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge({
        async generate() {
          return { choice: "finish" };
        },
      }),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host],
        hostBotId: f.host,
        text: "检查后告诉我结果",
      },
    });
    await waitFor(
      () => f.store.runs.getRun(created.id!)?.status === "completed",
    );
    assert.equal(f.calls.length, 2);
    assert.match(
      f.store.views
        .snapshot({ conversationId: created.conversationId })
        .messages.at(-1)!.text,
      /向用户交付/,
    );
  } finally {
    await runtime.stop();
    await f.close();
  }
});

await test("Jev service failures stop the discussion without dispatching members or silently switching models", async () => {
  const f = await fixture();
  const remote = await jevServer((_request, response) => {
    response.writeHead(401);
    response.end("provider diagnostic");
  });
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge(
        {
          async generate() {
            throw Error("service failure must be visible");
          },
        },
        new JevClient(remote.config, "key"),
      ),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker],
        hostBotId: f.host,
        text: "等待服务判断",
      },
    });
    await waitFor(() => f.store.runs.getRun(created.id!)?.status === "failed");
    assert.match(f.store.runs.getRun(created.id!)!.error!, /HTTP 401/);
    assert.equal(f.calls.length, 1);
    assert.equal(remote.requests.length, 1);
  } finally {
    await runtime.stop();
    await remote.close();
    await f.close();
  }
});

await test("directed requests bypass the host and Jev, and invalid hosts cannot create a group", async () => {
  const f = await fixture();
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () => {
      throw Error("direct mentions must not invoke a coordinator");
    },
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    assert.throws(
      () =>
        f.execute({
          type: "group.start",
          memberIds: [f.worker],
          hostBotId: f.host,
          text: "invalid",
        }),
      /主持人必须/,
    );
    const created = f.execute({
      type: "group.start",
      memberIds: [f.host, f.worker],
      text: "initial",
    });
    const parent = f.store.runs.claim()!;
    f.execute({ type: "run.cancel", runId: parent.id });
    f.store.runs.finish(parent.id, "cancelled", null);
    const group = f.store.views
      .snapshot({})
      .conversations.find((c) => c.id === created.conversationId)!.group!;
    f.execute({
      type: "group.update",
      conversationId: created.conversationId!,
      ...group,
      hostBotId: f.host,
    });
    const directed = commands.execute({
      id: randomUUID(),
      command: {
        type: "message.send",
        conversationId: created.conversationId!,
        recipientIds: [f.worker],
        text: "只交给执行者",
      },
    });
    await waitFor(
      () => f.store.runs.getRun(directed.id!)?.status === "completed",
    );
    assert.deepEqual(
      f.calls.map((call) => call.sessionScope?.botId),
      [f.worker, f.worker],
    );
    assert.equal(f.store.runs.host.info(directed.id!), null);
  } finally {
    await runtime.stop();
    await f.close();
  }
});

await test("uncertain Jev routing delegates to the host model, and failed members cannot be selected again", async () => {
  const f = await fixture();
  const remote = await jevServer((_request, response) =>
    jevAnswer(response, f.worker, 0.3),
  );
  let reasoning = 0;
  const judge = new HostJudge(
    {
      async generate() {
        reasoning++;
        return { choice: "wait" };
      },
    },
    new JevClient(remote.config, "key"),
  );
  const state: GroupHostState = {
    hostBotId: f.host,
    members: [{ id: f.worker, name: "执行者", description: "实现" }],
    messages: [],
    turns: [],
  };
  try {
    assert.deepEqual(await judge.decide(state, AbortSignal.timeout(5000)), {
      choice: "wait",
    });
    assert.equal(reasoning, 1);
    const rejected = new HostJudge({
      async generate() {
        return { choice: f.worker };
      },
    });
    await assert.rejects(
      rejected.decide(
        {
          ...state,
          turns: [
            { botId: f.worker, status: "failed", error: "结果未知，勿重试" },
          ],
        },
        AbortSignal.timeout(5000),
      ),
      /有效的下一步/,
    );
  } finally {
    await remote.close();
    await f.close();
  }
});

await test("cancelling while Jev is pending stops its HTTP request and never dispatches a late choice", async () => {
  const f = await fixture();
  let disconnected = false;
  const remote = await jevServer((_request, response) => {
    response.on("close", () => {
      disconnected = true;
    });
  });
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge(
        {
          async generate() {
            throw Error("unused");
          },
        },
        new JevClient(remote.config, "key"),
      ),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker],
        hostBotId: f.host,
        text: "等待调度时停止",
      },
    });
    await waitFor(() => remote.requests.length === 1);
    commands.execute({
      id: randomUUID(),
      command: { type: "run.cancel", runId: created.id! },
    });
    await waitFor(
      () => f.store.runs.getRun(created.id!)?.status === "cancelled",
    );
    await waitFor(() => disconnected);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.runs.getRun(created.id!)?.groupTurns.length, 1);
  } finally {
    await runtime.stop();
    await remote.close();
    await f.close();
  }
});

await test("failed members are not retried while other members and the host can still report the outcome", async () => {
  let failedBot = "";
  const f = await fixture(async (input) => {
    if (input.sessionScope?.botId === failedBot)
      throw Error("external execution failed");
    input.onEvent({
      type: "text",
      itemId: "reply",
      text: "根据实际结果汇报，失败事项仍未完成。",
      complete: true,
    });
  });
  failedBot = f.worker;
  const choices = [f.worker, f.unused, "finish"];
  const remote = await jevServer((request, response) => {
    if (remote.requests.length > 1)
      assert.ok(!Object.hasOwn(request.questions.next.criteria, failedBot));
    jevAnswer(response, choices[remote.requests.length - 1]!);
  });
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge(
        {
          async generate() {
            throw Error("unused");
          },
        },
        new JevClient(remote.config, "key"),
      ),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker, f.unused],
        hostBotId: f.host,
        text: "处理并复核",
      },
    });
    await waitFor(() => f.store.runs.getRun(created.id!)?.status === "failed");
    assert.deepEqual(
      f.calls.map((call) => call.sessionScope?.botId),
      [f.host, f.worker, f.unused, f.host],
    );
    assert.match(f.calls.at(-1)!.instructions, /现在负责收尾/);
    assert.deepEqual(
      f.store.runs.getRun(created.id!)?.groupTurns.map((turn) => turn.status),
      ["completed", "failed", "completed", "completed"],
    );
  } finally {
    await runtime.stop();
    await remote.close();
    await f.close();
  }
});

await test("v40 groups keep round-robin settings, and interrupted hosted work is never replayed and can be purged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-host-upgrade-"));
  const path = join(directory, "aster.sqlite");
  let store = new Store(path);
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  try {
    const bot = execute({
      type: "bot.create",
      name: "旧成员",
      description: "",
    });
    const created = execute({
      type: "group.start",
      memberIds: [bot.id!],
      text: "升级前记录",
    });
    const oldRun = store.runs.claim()!;
    execute({ type: "run.cancel", runId: oldRun.id });
    store.runs.finish(oldRun.id, "cancelled", null);
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP TABLE group_discussions; ALTER TABLE groups DROP COLUMN hostBotId; PRAGMA user_version=40;",
    );
    legacy.close();
    store = new Store(path);
    const group = store.views
      .snapshot({})
      .conversations.find((item) => item.id === created.conversationId)!.group!;
    assert.equal(group.hostBotId, null);
    execute({
      type: "group.update",
      conversationId: created.conversationId!,
      ...group,
      hostBotId: bot.id!,
    });
    const run = execute({
      type: "message.send",
      conversationId: created.conversationId!,
      text: "新主持任务",
    });
    const parent = store.runs.claim()!;
    assert.equal(store.runs.nextGroupTurn(parent)?.botId, bot.id);
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(store.runs.getRun(run.id!)?.status, "unknown");
    assert.equal(store.runs.getRun(run.id!)?.groupTurns[0]?.status, "unknown");
    assert.equal(store.runs.nextGroupTurn(parent), null);
    assert.equal(store.runs.claim(), undefined);
    assert.equal(store.runs.host.info(run.id!)?.hostBotId, bot.id);
    store.close();
    const cleanup = new DatabaseSync(path);
    try {
      cleanup.exec("PRAGMA foreign_keys=ON;");
      purgeConversation(cleanup, created.conversationId!);
      assert.equal(
        cleanup.prepare("SELECT count(*) n FROM group_discussions").get()?.n,
        0,
      );
      assert.deepEqual(cleanup.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      cleanup.close();
    }
    store = new Store(path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("hosted discussion has a hard turn limit and reserves its last turn for an honest handover", async () => {
  const f = await fixture();
  const runtime = new Runtime(
    f.store,
    f.agent,
    join(f.directory, "workspaces"),
    undefined,
    undefined,
    undefined,
    async () =>
      new HostJudge({
        async generate() {
          return { choice: f.worker };
        },
      }),
  );
  const commands = new WorkspaceCommands(f.store, runtime);
  try {
    const created = commands.execute({
      id: randomUUID(),
      command: {
        type: "group.start",
        memberIds: [f.host, f.worker],
        hostBotId: f.host,
        text: "持续有工作",
      },
    });
    await waitFor(() => f.store.runs.getRun(created.id!)?.status === "failed");
    assert.equal(f.calls.length, groupTurnLimit);
    assert.equal(f.calls.at(-1)?.sessionScope?.botId, f.host);
    assert.match(f.calls.at(-1)!.instructions, /不能声称任务已全部完成/);
    assert.match(f.store.runs.getRun(created.id!)!.error!, /执行上限/);
  } finally {
    await runtime.stop();
    await f.close();
  }
});
