import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";

const envelope = (command: Command) => ({
  id: randomUUID(),
  command,
});
const create = {
  action: "create" as const,
  name: "整理",
  description: "用于整理输入",
  body: "仅总结用户给出的资料。",
};

await test("skill calls atomically preserve versions and visible receipts, reject stale/scope writes and deduplicate after reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-skill-tools-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    const other = store.execute(
      envelope({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(bot.id && bot.conversationId && other.id && other.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "保存技能",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const request = { callId: "save-1", operation: create };
    const saved = store.toolOperations.skillToolRequest(job, request);
    assert.ok(saved.action === "create");
    const ref = saved.skill;
    const changed = store.views.snapshot({
      conversationId: bot.conversationId,
    });
    assert.equal(
      changed.messages.filter((m) => m.id === saved.messageId).length,
      1,
    );
    assert.equal(
      changed.messages.find((m) => m.id === saved.messageId)?.skills[0]
        ?.revision,
      1,
    );
    // A disconnected caller can recover the exact committed receipt without a second version.
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.toolOperations.skillToolRequest(job, request),
      saved,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          ...request,
          operation: { ...create, body: "changed" },
        }),
      /改变参数/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          callId: "duplicate-name",
          operation: create,
        }),
      /同名/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(
          { ...job, conversationId: other.conversationId! },
          { callId: "cross-conversation", operation: { action: "list" } },
        ),
      /不匹配/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(
          { ...job, botId: other.id! },
          { callId: "cross-bot", operation: { action: "list" } },
        ),
      /运行已经结束/,
    );
    const update = {
      callId: "update",
      operation: {
        ...create,
        action: "update",
        id: ref.id,
        revision: 1,
        body: "新的正文",
      },
    };
    const updated = store.toolOperations.skillToolRequest(job, update);
    assert.ok(updated.action === "update");
    assert.equal(updated.skill.revision, 2);
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          ...update,
          callId: "stale",
        }),
      /版本已改变/,
    );
    assert.equal(store.skillContent(ref).body, create.body);
    const removed = store.toolOperations.skillToolRequest(job, {
      callId: "delete",
      operation: { action: "delete", id: ref.id, revision: 2 },
    });
    assert.ok(removed.action === "delete");
    assert.equal(store.skillCatalog([bot.id]).length, 0);
    assert.equal(store.skillContent({ ...ref, revision: 2 }).body, "新的正文");
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          callId: "deleted-read",
          operation: { action: "read", id: ref.id, revision: 2 },
        }),
      /已删除/,
    );
    store.execute(envelope({ type: "run.cancel", runId: job.id }));
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          callId: "late",
          operation: { ...create, name: "迟到" },
        }),
      /运行已经结束/,
    );
    assert.equal(store.skillCatalog([bot.id]).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group skills expose only received frozen user references and never a member private catalog", () => {
  const store = new Store(":memory:");
  const execute = (command: Command) => store.execute(envelope(command));
  try {
    const a = execute({ type: "bot.create", name: "A", description: "" }),
      b = execute({ type: "bot.create", name: "B", description: "" });
    assert.ok(a.id && b.id);
    const sharedId = randomUUID(),
      privateId = randomUUID();
    for (const [id, name] of [
      [sharedId, "shared"],
      [privateId, "private"],
    ]) {
      assert.ok(id && name);
      execute({
        type: "skill.save",
        id,
        botId: a.id,
        revision: 0,
        name,
        description: "scope",
        body: "frozen",
      });
    }
    const group = execute({
      type: "group.start",
      memberIds: [a.id, b.id],
      text: "读共享版本",
      skills: [{ id: sharedId, botId: a.id, revision: 1 }],
    });
    assert.ok(group.conversationId);
    const parent = store.runs.claim();
    assert.ok(parent);
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(parent, {
          callId: "parent-not-member",
          operation: { action: "list" },
        }),
      /运行已经结束/,
    );
    const member = store.runs.nextGroupTurn(parent);
    assert.ok(member);
    execute({
      type: "skill.save",
      id: sharedId,
      botId: a.id,
      revision: 1,
      name: "shared",
      description: "new",
      body: "private update",
    });
    const list = store.toolOperations.skillToolRequest(member, {
      callId: "list",
      operation: { action: "list" },
    });
    assert.equal(list.action, "list");
    assert.ok(list.action === "list");
    assert.deepEqual(
      store.toolOperations.skillDiscoveryCatalog(member),
      list.skills,
    );
    assert.deepEqual(
      list.skills.map((s) => [s.id, s.revision]),
      [[sharedId, 1]],
    );
    const read = store.toolOperations.skillToolRequest(member, {
      callId: "read",
      operation: { action: "read", id: sharedId, revision: 1 },
    });
    assert.ok(read.action === "read");
    assert.equal(read.skill.body, "frozen");
    for (const operation of [
      { action: "read", id: sharedId, revision: 2 },
      { action: "read", id: privateId, revision: 1 },
      create,
    ])
      assert.throws(
        () =>
          store.toolOperations.skillToolRequest(member, {
            callId: randomUUID(),
            operation,
          }),
        /未向当前群成员|群聊不能修改/,
      );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(
          { ...member, groupOrdinal: undefined },
          { callId: "forged-private", operation: create },
        ),
      /运行已经结束/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillDiscoveryCatalog({
          ...member,
          groupOrdinal: undefined,
        }),
      /运行已经结束/,
    );
    store.runs.finishGroupTurn(member, "completed", null);
    assert.throws(
      () => store.toolOperations.skillDiscoveryCatalog(member),
      /运行已经结束/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(member, {
          callId: "old-turn",
          operation: { action: "list" },
        }),
      /运行已经结束/,
    );
  } finally {
    store.close();
  }
});

/** epoch 标识连接实例而非数据。 */
function withoutEpoch<T extends { epoch: string }>(
  view: T,
): Omit<T, "epoch"> & { epoch: null } {
  return { ...view, epoch: null };
}

await test("skill receipt transaction failure rolls back the visible receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-skill-migrate-")),
    path = join(directory, "db.sqlite");
  const store = new Store(path);
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "Before", description: "" }),
    );
    assert.ok(bot.id && bot.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "original input",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const before = store.views.snapshot({ conversationId: bot.conversationId });
    const fault = new DatabaseSync(path);
    try {
      fault.exec(
        "CREATE TRIGGER fail_skill_receipt BEFORE INSERT ON skill_tool_calls BEGIN SELECT RAISE(ABORT,'fixture receipt unavailable'); END;",
      );
    } finally {
      fault.close();
    }
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          callId: "rollback",
          operation: create,
        }),
      /receipt unavailable/,
    );
    assert.equal(store.skillCatalog([bot.id]).length, 0);
    assert.deepEqual(
      withoutEpoch(
        store.views.snapshot({ conversationId: bot.conversationId }),
      ),
      withoutEpoch(before),
    );
    const repair = new DatabaseSync(path);
    try {
      repair.exec("DROP TRIGGER fail_skill_receipt");
    } finally {
      repair.close();
    }
    const saved = store.toolOperations.skillToolRequest(job, {
      callId: "rollback",
      operation: create,
    });
    assert.ok(saved.action === "create");
    assert.equal(saved.skill.revision, 1);
    for (let index = 1; index < 24; index++)
      store.toolOperations.skillToolRequest(job, {
        callId: String(index),
        operation: { action: "list" },
      });
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(job, {
          callId: "over-limit",
          operation: { ...create, name: "overflow" },
        }),
      /24 次/,
    );
    assert.equal(store.skillCatalog([bot.id]).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("skill capability disappears synchronously when the runtime cancels or closes", async () => {
  const store = new Store(":memory:");
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "scope", description: "" }),
    );
    assert.ok(bot.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "create",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const tools = new ToolService(store, 12345);
    const controller = new AbortController(),
      scope = tools.open(job, controller.signal);
    const input = { callId: "one", operation: create };
    assert.throws(
      () => tools.skills("invalid", input, new AbortController().signal),
      /授权已结束/,
    );
    const result = tools.skills(
      scope.connection.token,
      input,
      new AbortController().signal,
    );
    assert.equal(result.action, "create");
    controller.abort();
    assert.throws(
      () =>
        tools.skills(
          scope.connection.token,
          { ...input, callId: "late" },
          new AbortController().signal,
        ),
      /授权已结束/,
    );
    await scope.close();
    assert.equal(store.skillCatalog([job.botId]).length, 1);
  } finally {
    store.close();
  }
});
