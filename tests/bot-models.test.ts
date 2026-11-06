import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentConnections } from "../src/agent/connections.js";
import { LiveAgent } from "../src/agent/live.js";
import type { Agent } from "../src/chat/agent.js";
import { Runtime } from "../src/chat/runtime.js";
import {
  agentConnectionSchema,
  agentConnectionsRequestSchema,
} from "../src/shared/agent-connections.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

await test("Bot assignments persist independently, capture their own model and never fall back from unavailable selections", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-bot-models-"));
  try {
    const service = new AgentConnections(home);
    const first = agentConnectionSchema.parse({
      id: "first",
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "ASTER_TEST_BOT_FIRST_MISSING",
    });
    const second = agentConnectionSchema.parse({
      ...first,
      id: "second",
      apiKeyEnv: "ASTER_TEST_BOT_SECOND_MISSING",
    });
    assert.equal(
      agentConnectionsRequestSchema.safeParse({
        action: "assign",
        botId: "other",
        connectionId: "first",
      }).success,
      false,
    );
    await service.request(
      {
        action: "save",
        revision: service.status().revision,
        config: { defaultAgent: "first", connections: [first, second] },
      },
      AbortSignal.timeout(5000),
    );
    const a = randomUUID(),
      b = randomUUID();
    await service.request(
      { action: "assign", botId: a, connectionId: "first" },
      AbortSignal.timeout(5000),
    );
    await service.request(
      { action: "assign", botId: b, connectionId: "second" },
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(
      new AgentConnections(home).status().config.botConnections,
      { [a]: "first", [b]: "second" },
    );
    const agent = new LiveAgent(home),
      captured = agent.capture(a);
    await assert.rejects(captured.check(), /ASTER_TEST_BOT_FIRST_MISSING/);
    await assert.rejects(
      agent.capture(b).check(),
      /ASTER_TEST_BOT_SECOND_MISSING/,
    );
    await service.request(
      { action: "assign", botId: a, connectionId: "second" },
      AbortSignal.timeout(5000),
    );
    await assert.rejects(captured.check(), /ASTER_TEST_BOT_FIRST_MISSING/);
    await assert.rejects(
      agent.capture(a).check(),
      /ASTER_TEST_BOT_SECOND_MISSING/,
    );
    const before = service.status();
    await service.request(
      {
        action: "save",
        revision: before.revision,
        config: {
          ...before.config,
          connections: [first, { ...second, enabled: false }],
        },
      },
      AbortSignal.timeout(5000),
    );
    assert.throws(() => agent.capture(a), /供应商已停用/);
    assert.throws(() => agent.capture(b), /供应商已停用/);
    assert.throws(() => agent.capture(randomUUID()), /Bot 设置/);
    const disabled = service.status();
    await assert.rejects(
      service.request(
        { action: "assign", botId: a, connectionId: "second" },
        AbortSignal.timeout(5000),
      ),
      /已停用或不存在/,
    );
    await assert.rejects(
      service.request(
        { action: "assign", botId: a, connectionId: "missing" },
        AbortSignal.timeout(5000),
      ),
      /已停用或不存在/,
    );
    assert.equal(service.status().revision, disabled.revision);
    await service.request(
      {
        action: "save",
        revision: disabled.revision,
        config: { ...disabled.config, connections: [first] },
      },
      AbortSignal.timeout(5000),
    );
    assert.throws(() => agent.capture(a), /Bot 设置/);
    assert.throws(() => agent.capture(b), /Bot 设置/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("private runs and each group member capture the owning Bot instead of one global agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-bot-capture-"));
  const store = new Store(join(home, "db.sqlite"));
  const captured: string[] = [];
  const agent: Agent = {
    check: async () => ({ accountType: "fixture", detail: "fixture" }),
    run: async () => {
      throw Error("uncaptured agent");
    },
    capture: (botId) => {
      assert.ok(botId);
      captured.push(botId);
      return {
        check: async () => ({ accountType: "fixture", detail: "fixture" }),
        run: async (input) => {
          assert.equal(input.sessionScope?.botId, botId);
          input.onEvent({
            type: "text",
            itemId: "reply",
            text: "完成",
            complete: true,
          });
          return { status: "completed", error: null };
        },
      };
    },
  };
  const runtime = new Runtime(store, agent, join(home, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const command = (value: Command) =>
    commands.execute(
      envelopeSchema.parse({ id: randomUUID(), command: value }),
    );
  const waitFor = async (id: string) => {
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      ["queued", "running"].includes(store.runs.getRun(id)?.status ?? "")
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.runs.getRun(id)?.status, "completed");
  };
  try {
    const a = command({ type: "bot.create", name: "A", description: "" });
    const b = command({ type: "bot.create", name: "B", description: "" });
    assert.ok(a.id && a.conversationId && b.id && b.conversationId);
    const first = command({
      type: "message.send",
      conversationId: a.conversationId,
      text: "hello",
    });
    assert.ok(first.id);
    await waitFor(first.id);
    assert.deepEqual(captured, [a.id]);
    captured.length = 0;
    const group = command({
      type: "group.start",
      memberIds: [a.id, b.id],
      text: "discuss",
    });
    assert.ok(group.id);
    await waitFor(group.id);
    assert.deepEqual(new Set(captured), new Set([a.id, b.id]));
  } finally {
    await runtime.stop();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
