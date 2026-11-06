import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Agent, AgentInput } from "../src/chat/agent.js";
import { ContextManager } from "../src/chat/context-manager.js";
import { Runtime } from "../src/chat/runtime.js";
import {
  skillDiscoveryByteLimit,
  skillDiscoveryContext,
} from "../src/chat/skill-discovery.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { skillSummarySchema } from "../src/shared/tools/skills.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";

function envelope(command: Command) {
  return envelopeSchema.parse({ id: randomUUID(), command });
}
const catalogSchema = z.object({
  skills: z.array(
    skillSummarySchema
      .pick({
        id: true,
        revision: true,
        name: true,
        description: true,
      })
      .strict(),
  ),
  total: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
});
function catalog(text: string) {
  const json = text.split("\n技能目录 JSON：\n")[1];
  assert.ok(json);
  return catalogSchema.parse(JSON.parse(json));
}
async function runToEnd(runtime: Runtime, store: Store, command: Command) {
  const commands = new WorkspaceCommands(store, runtime);
  const run = commands.execute(envelope(command));
  assert.ok(run.id);
  const signal = AbortSignal.timeout(5000);
  while (
    ["queued", "running"].includes(store.runs.getRun(run.id)?.status ?? "")
  ) {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const finished = store.runs.getRun(run.id);
  assert.equal(finished?.status, "completed", finished?.error ?? undefined);
}

await test("skill discovery bounds UTF-8 bytes and preserves complete summary records with explicit omissions", () => {
  assert.deepEqual(catalog(skillDiscoveryContext([])), {
    skills: [],
    total: 0,
    omitted: 0,
  });
  const summaries = Array.from({ length: 100 }, (_, index) => ({
    id: randomUUID(),
    botId: randomUUID(),
    revision: index + 1,
    name: `技能 ${index}`,
    description: '用途\n"🍬'.repeat(80),
    updatedAt: 0,
  }));
  const context = skillDiscoveryContext(summaries);
  assert.ok(Buffer.byteLength(context) <= skillDiscoveryByteLimit);
  const result = catalog(context);
  assert.ok(result.skills.length > 0 && result.skills.length < 100);
  assert.equal(result.total, 100);
  assert.equal(result.omitted, 100 - result.skills.length);
  assert.deepEqual(
    result.skills,
    summaries
      .slice(0, result.skills.length)
      .map(({ id, revision, name, description }) => ({
        id,
        revision,
        name,
        description,
      })),
  );
});

await test("runtime discovers unmentioned skills on resumed and steer turns, reads their bodies, and refreshes changes without persisting catalogs as messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-discovery-runtime-"));
  const store = new Store(join(directory, "db.sqlite"));
  const tools = new ToolService(store, 12345);
  const inputs: AgentInput[] = [];
  const bodies: string[] = [];
  let skillId = randomUUID();
  let botId = "";
  let conversationId = "";
  const agent: Agent = {
    async check() {
      return { accountType: "test", detail: "test" };
    },
    async run(input) {
      inputs.push(input);
      assert.ok(input.toolAccess);
      const listed = await tools.read(
        input.toolAccess.token,
        {
          callId: `list-${inputs.length}`,
          path: "/skills",
        },
        input.signal,
      );
      assert.ok(listed.type === "directory");
      const discovered = catalog(input.text);
      assert.deepEqual(
        discovered.skills.map((skill) => [skill.id, skill.revision]),
        listed.entries.map((entry) => [
          entry.path.split("/")[2],
          Number(entry.path.split("/")[3]),
        ]),
      );
      if (listed.entries.length) {
        const ref = discovered.skills[0];
        assert.ok(ref);
        const read = await tools.read(
          input.toolAccess.token,
          {
            callId: `read-${inputs.length}`,
            path: `/skills/${ref.id}/${ref.revision}/SKILL.md`,
          },
          input.signal,
        );
        assert.ok(read.type === "text");
        assert.ok(!input.text.includes(read.text));
        bodies.push(read.text);
      } else {
        assert.equal(discovered.total, 0);
        assert.equal(discovered.omitted, 0);
      }
      input.onEvent({ type: "thread", threadId: "discovery-thread" });
      if (inputs.length === 1) {
        commands.execute(
          envelope({
            type: "skill.save",
            id: skillId,
            botId,
            revision: 1,
            name: "整理纪要",
            description: "处理会议记录",
            body: "BODY_V2",
          }),
        );
        commands.execute(
          envelope({ type: "message.send", conversationId, text: "补充记录" }),
        );
      }
      return { status: "completed", error: null };
    },
  };
  const runtime = new Runtime(
    store,
    agent,
    join(directory, "workspaces"),
    undefined,
    tools,
  );
  const commands = new WorkspaceCommands(store, runtime);
  try {
    const created = commands.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    assert.ok(created.id && created.conversationId);
    botId = created.id;
    conversationId = created.conversationId;
    commands.execute(
      envelope({
        type: "skill.save",
        id: skillId,
        botId,
        revision: 0,
        name: "整理纪要",
        description: "处理会议记录",
        body: "BODY_V1",
      }),
    );
    const other = commands.execute(
      envelope({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(other.id);
    commands.execute(
      envelope({
        type: "skill.save",
        id: randomUUID(),
        botId: other.id,
        revision: 0,
        name: "OTHER_BOT_SECRET",
        description: "other",
        body: "OTHER_BODY",
      }),
    );
    await runToEnd(runtime, store, {
      type: "message.send",
      conversationId,
      text: "整理会议记录",
    });
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]?.threadId, "discovery-thread");
    commands.execute(
      envelope({ type: "skill.delete", id: skillId, botId, revision: 2 }),
    );
    skillId = randomUUID();
    commands.execute(
      envelope({
        type: "skill.save",
        id: skillId,
        botId,
        revision: 0,
        name: "新技能",
        description: "处理新任务",
        body: "NEW_BODY",
      }),
    );
    await runToEnd(runtime, store, {
      type: "message.send",
      conversationId,
      text: "新任务",
    });
    assert.equal(inputs[2]?.threadId, "discovery-thread");
    assert.doesNotMatch(inputs[2]?.text ?? "", /整理纪要/);
    commands.execute(
      envelope({ type: "skill.delete", id: skillId, botId, revision: 1 }),
    );
    await runToEnd(runtime, store, {
      type: "message.send",
      conversationId,
      text: "没有技能",
    });
    assert.deepEqual(bodies, ["BODY_V1", "BODY_V2", "NEW_BODY"]);
    for (const input of inputs)
      assert.doesNotMatch(input.text, /OTHER_BOT_SECRET|OTHER_BODY/);
    assert.deepEqual(
      store.views
        .snapshot({ conversationId })
        .messages.filter((message) => message.role === "user")
        .map((message) => message.text),
      ["整理会议记录", "补充记录", "新任务", "没有技能"],
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group discovery matches scoped list and reads only received frozen versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-discovery-group-"));
  const store = new Store(join(directory, "db.sqlite"));
  const tools = new ToolService(store, 12345);
  let turns = 0;
  const sharedId = randomUUID();
  const agent: Agent = {
    async check() {
      return { accountType: "test", detail: "test" };
    },
    async run(input) {
      turns++;
      assert.ok(input.toolAccess);
      const discovered = catalog(input.text);
      assert.deepEqual(
        discovered.skills.map((skill) => [skill.id, skill.revision]),
        [[sharedId, 1]],
      );
      assert.doesNotMatch(
        input.text + input.instructions,
        /PRIVATE_SKILL|PRIVATE_BODY|NEW_PRIVATE_VERSION/,
      );
      const listed = await tools.read(
        input.toolAccess.token,
        {
          callId: "list",
          path: "/skills",
        },
        input.signal,
      );
      assert.ok(listed.type === "directory");
      assert.deepEqual(
        listed.entries.map((entry) => [
          entry.path.split("/")[2],
          Number(entry.path.split("/")[3]),
        ]),
        [[sharedId, 1]],
      );
      const read = await tools.read(
        input.toolAccess.token,
        {
          callId: "read",
          path: `/skills/${sharedId}/1/SKILL.md`,
        },
        input.signal,
      );
      assert.ok(read.type === "text");
      assert.equal(read.text, "共享的旧正文");
      return { status: "completed", error: null };
    },
  };
  const runtime = new Runtime(
    store,
    agent,
    join(directory, "workspaces"),
    undefined,
    tools,
  );
  try {
    const execute = (command: Command) => store.execute(envelope(command));
    const a = execute({ type: "bot.create", name: "A", description: "" });
    const b = execute({ type: "bot.create", name: "B", description: "" });
    assert.ok(a.id && b.id);
    execute({
      type: "skill.save",
      id: sharedId,
      botId: a.id,
      revision: 0,
      name: "共享技能",
      description: "处理共享任务",
      body: "共享的旧正文",
    });
    for (const botId of [a.id, b.id])
      execute({
        type: "skill.save",
        id: randomUUID(),
        botId,
        revision: 0,
        name: "PRIVATE_SKILL",
        description: "private",
        body: "PRIVATE_BODY",
      });
    const group = execute({
      type: "group.start",
      memberIds: [a.id, b.id],
      text: "讨论",
      skills: [{ id: sharedId, botId: a.id, revision: 1 }],
    });
    assert.ok(group.conversationId);
    execute({
      type: "skill.save",
      id: sharedId,
      botId: a.id,
      revision: 1,
      name: "NEW_PRIVATE_VERSION",
      description: "private",
      body: "NEW_PRIVATE_VERSION",
    });
    await runToEnd(runtime, store, {
      type: "message.send",
      conversationId: group.conversationId,
      text: "继续讨论",
    });
    assert.ok(turns >= 2);
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("input preparation uses the current scoped catalog without an application summary call", async () => {
  const store = new Store(":memory:");
  try {
    const created = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    assert.ok(created.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: created.conversationId,
        text: "继续",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const manager = new ContextManager(store);
    const text = "新目录".repeat(1000);
    const prepared = await manager.prepare(
      job,
      "old",
      () => text,
      "rules",
      "/workspace",
      AbortSignal.timeout(5000),
      false,
    );
    assert.equal(prepared.text, text);
    assert.equal(prepared.restartThread, false);
    assert.equal(prepared.context, "");
  } finally {
    store.close();
  }
});
