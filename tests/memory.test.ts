import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindMemoryProposal, MemoryService } from "../src/memory/service.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import type { MemoryWork, StructuredModel } from "../src/shared/memory.js";
import { Store } from "../src/storage/store.js";
const req = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });
function bot(store: Store, name = "A") {
  const b = store.execute(req({ type: "bot.create", name, description: "" }));
  assert.ok(b.id && b.conversationId);
  return { id: b.id, conversationId: b.conversationId };
}
function finish(store: Store, conversationId: string, text: string) {
  store.execute(req({ type: "message.send", conversationId, text }));
  const job = store.runs.claim();
  assert.ok(job);
  store.runs.finish(job.id, "completed", null);
  return job;
}
const proposal = (work: MemoryWork, topic = "偏好", content = work.text) => ({
  conflicts: [],
  changes: [{ id: null, revision: 0, topic, content, quote: work.text }],
});

await test("model-proposed revisions cannot replace the stored revision or another memory's identity", () => {
  const automaticId = randomUUID();
  const manualId = randomUUID();
  const botId = randomUUID();
  const work: MemoryWork = {
    id: randomUUID(),
    revision: 7,
    sourceMessageId: randomUUID(),
    text: "现在把长期校验代号改为 NEW。",
    scope: { botId, conversationId: null },
    forgottenTopics: [],
    entries: [
      {
        id: automaticId,
        topic: "长期校验代号",
        content: "旧代号是 OLD",
        revision: 1,
        origin: "automatic",
        sourceMessageId: randomUUID(),
        sourceQuote: "旧代号是 OLD",
        updatedAt: 1,
      },
      {
        id: manualId,
        topic: "回复偏好",
        content: "简短回复",
        revision: 3,
        origin: "manual",
        sourceMessageId: null,
        sourceQuote: null,
        updatedAt: 2,
      },
    ],
  };
  const change = {
    id: automaticId,
    revision: 2,
    topic: "长期校验代号",
    content: "新代号是 NEW",
    quote: "现在把长期校验代号改为 NEW。",
  };
  const bound = bindMemoryProposal(work, { conflicts: [], changes: [change] });
  assert.equal(bound.changes[0]?.revision, 1);
  assert.equal(bound.changes[0]?.id, automaticId);
  for (const invalid of [
    { ...change, id: randomUUID() },
    { ...change, topic: "另一个主题" },
    { ...change, id: manualId, topic: "回复偏好" },
  ])
    assert.throws(
      () => bindMemoryProposal(work, { conflicts: [], changes: [invalid] }),
      /身份或主题/,
    );
});

await test("memory commits require exact evidence and current revisions; forgetting fences old work and recovery never repeats inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-memory-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const a = bot(store),
      scope = { botId: a.id, conversationId: null };
    assert.equal(store.memoryOperations.memoryView(scope).automatic, false);
    finish(store, a.conversationId, "我偏好一号颜色");
    assert.equal(store.memoryOperations.memoryClaim(), null);
    store.execute(
      req({ type: "memory.auto", scope, revision: 0, enabled: true }),
    );
    finish(store, a.conversationId, "我偏好二号颜色");
    const work = store.memoryOperations.memoryClaim();
    assert.ok(work);
    assert.throws(
      () =>
        store.memoryOperations.memoryApply(work, {
          conflicts: [],
          changes: [{ ...proposal(work).changes[0]!, quote: "原文没有的话" }],
        }),
      /引文无效/,
    );
    store.memoryOperations.memoryVerify(work);
    store.memoryOperations.memoryApply(work, proposal(work));
    let entry = store.memoryOperations.memoryView(scope).entries[0];
    assert.ok(entry);
    assert.equal(entry.sourceQuote, work.text);
    const source = entry.sourceMessageId;
    const latest = finish(store, a.conversationId, "我现在偏好三号颜色");
    assert.match(
      store.memoryOperations.memoryContext(latest),
      /不能声称已保存、已更新或已遗忘/,
    );
    const newer = store.memoryOperations.memoryClaim();
    assert.ok(newer);
    const save = req({
      type: "memory.save",
      scope,
      id: entry.id,
      revision: entry.revision,
      topic: entry.topic,
      content: "用户手动修正",
    });
    store.execute(save);
    store.execute(save);
    store.memoryOperations.memoryApply(newer, {
      conflicts: [],
      changes: [
        {
          id: entry.id,
          revision: entry.revision,
          topic: entry.topic,
          content: newer.text,
          quote: newer.text,
        },
      ],
    });
    entry = store.memoryOperations.memoryView(scope).entries[0];
    assert.ok(entry);
    assert.equal(entry.content, "用户手动修正");
    assert.equal(entry.revision, 2);
    store.execute(
      req({
        type: "memory.forget",
        scope,
        id: entry.id,
        revision: entry.revision,
      }),
    );
    assert.deepEqual(store.memoryOperations.memoryView(scope).entries, []);
    assert.throws(
      () =>
        store.execute(
          req({ type: "memory.job", scope, id: newer.id, action: "retry" }),
        ),
      /作废/,
    );
    finish(store, a.conversationId, "我偏好四号颜色");
    const late = store.memoryOperations.memoryClaim();
    assert.ok(late);
    assert.throws(
      () => store.memoryOperations.memoryApply(late, proposal(late)),
      /忘记/,
    );
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(
      store.memoryOperations
        .memoryView(scope)
        .jobs.find((j) => j.id === late.id)?.status,
      "failed",
    );
    assert.equal(store.memoryOperations.memoryClaim(), null);
    assert.ok(
      store.views
        .snapshot({ conversationId: a.conversationId })
        .messages.some((m) => m.id === source),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("memory scopes separate Bot private facts and groups; revisions and all proposal writes roll back together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-memory-scopes-")),
    store = new Store(join(directory, "db.sqlite"));
  try {
    const a = bot(store),
      b = bot(store, "B"),
      scope = { botId: a.id, conversationId: null },
      secret = "PRIVATE_" + randomUUID();
    store.execute(
      req({
        type: "memory.save",
        scope,
        id: randomUUID(),
        revision: 0,
        topic: "私人偏好",
        content: secret,
      }),
    );
    const group = store.execute(
      req({
        type: "group.start",
        memberIds: [a.id, b.id],
        text: "讨论共同资料",
      }),
    );
    assert.ok(group.conversationId);
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    assert.ok(!store.memoryOperations.memoryContext(turn).includes(secret));
    assert.deepEqual(
      store.memoryOperations.memoryView({ botId: b.id, conversationId: null })
        .entries,
      [],
    );
    assert.throws(
      () =>
        store.memoryOperations.memoryView({
          botId: a.id,
          conversationId: a.conversationId,
        }),
      /群成员/,
    );
    store.runs.finish(parent.id, "cancelled", null);
    const groupScope = { botId: a.id, conversationId: group.conversationId };
    store.execute(
      req({
        type: "memory.auto",
        scope: groupScope,
        revision: 0,
        enabled: true,
      }),
    );
    store.execute(
      req({
        type: "message.send",
        conversationId: group.conversationId,
        text: "这个群的会议时间是每周三",
      }),
    );
    const discussion = store.runs.claim();
    assert.ok(discussion);
    let member = store.runs.nextGroupTurn(discussion);
    while (member) {
      store.runs.finishGroupTurn(member, "completed", null);
      member = store.runs.nextGroupTurn(discussion);
    }
    store.runs.finish(discussion.id, "completed", null);
    const groupWork = store.memoryOperations.memoryClaim();
    assert.ok(groupWork);
    assert.deepEqual(groupWork.scope, groupScope);
    assert.equal(store.memoryOperations.memoryActive(groupWork), true);
    const groupState = store.views
      .snapshot({})
      .conversations.find((c) => c.id === group.conversationId)?.group;
    assert.ok(groupState);
    store.execute(
      req({
        type: "group.update",
        ...groupState,
        conversationId: group.conversationId,
        memberIds: [b.id],
      }),
    );
    assert.equal(store.memoryOperations.memoryActive(groupWork), false);
    store.memoryOperations.memoryApply(groupWork, proposal(groupWork, "会议"));
    assert.throws(
      () => store.memoryOperations.memoryView(groupScope),
      /群成员/,
    );
    store.memoryOperations.memoryEnd(groupWork, "cancelled", "群成员已移除");
    store.execute(
      req({
        type: "memory.auto",
        scope,
        revision: store.memoryOperations.memoryView(scope).revision,
        enabled: true,
      }),
    );
    finish(store, a.conversationId, "我偏好黄色，并且喜欢短回复");
    const work = store.memoryOperations.memoryClaim();
    assert.ok(work);
    assert.throws(
      () =>
        store.memoryOperations.memoryApply(work, {
          conflicts: [],
          changes: [
            {
              id: null,
              revision: 0,
              topic: "新主题",
              content: "偏好黄色",
              quote: "我偏好黄色",
            },
            {
              id: null,
              revision: 0,
              topic: "私人偏好",
              content: "短回复",
              quote: "喜欢短回复",
            },
          ],
        }),
      /已存在/,
    );
    assert.equal(store.memoryOperations.memoryView(scope).entries.length, 1);
    assert.equal(
      store.memoryOperations.memoryView(scope).entries[0]?.content,
      secret,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("memory cancellation reaches the owned inference and a late model response cannot commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-memory-cancel-")),
    store = new Store(join(directory, "db.sqlite"));
  let entered: () => void = () => {},
    sawAbort = false;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const model: StructuredModel = {
    generate: ({ signal }) =>
      new Promise((resolve) => {
        entered();
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve({ conflicts: [], changes: [] });
          },
          { once: true },
        );
      }),
  };
  const service = new MemoryService(store, model);
  try {
    const a = bot(store),
      scope = { botId: a.id, conversationId: null };
    store.execute(
      req({ type: "memory.auto", scope, revision: 0, enabled: true }),
    );
    finish(store, a.conversationId, "我偏好简明回复");
    service.wake();
    await started;
    const work = store.memoryOperations.memoryView(scope).jobs[0];
    assert.ok(work);
    store.execute(
      req({ type: "memory.job", scope, id: work.id, action: "cancel" }),
    );
    assert.equal(
      store.memoryOperations.memoryView(scope).jobs[0]?.status,
      "cancelling",
    );
    service.wake();
    await service.stop();
    assert.equal(sawAbort, true);
    assert.equal(
      store.memoryOperations.memoryView(scope).jobs[0]?.status,
      "cancelled",
    );
    assert.equal(store.memoryOperations.memoryView(scope).entries.length, 0);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
