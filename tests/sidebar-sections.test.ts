import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Command } from "../src/shared/commands.js";
import { sectionCommandSchema } from "../src/shared/chat/sidebar-sections.js";
import { Store } from "../src/storage/store.js";

const request = (command: Command) => ({
  id: randomUUID(),
  command,
});

await test("sidebar sections persist unique ownership, reject stale writes, and delete only membership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sections-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const a = store.execute(
      request({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      request({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.conversationId && b.conversationId && a.id);
    const aConversationId = a.conversationId;
    const first = randomUUID(),
      second = randomUUID();
    const create = request({
      type: "section.create",
      revision: 0,
      id: first,
      name: "研究",
      conversationId: a.conversationId,
    });
    store.execute(create);
    store.execute(create); // A response lost after commit cannot create another section.
    assert.equal(store.views.snapshot({}).sidebar.revision, 1);
    assert.throws(
      () =>
        store.execute(
          request({
            type: "section.rename",
            revision: 0,
            id: first,
            name: "陈旧写入",
          }),
        ),
      /分组已在其他操作中更改/,
    );
    assert.equal(store.views.snapshot({}).sidebar.sections[0]?.name, "研究");
    store.execute(
      request({
        type: "section.create",
        revision: 1,
        id: second,
        name: "生活",
        conversationId: a.conversationId,
      }),
    );
    assert.deepEqual(
      store.views
        .snapshot({})
        .sidebar.sections.map((section) => [
          section.id,
          section.conversationIds,
        ]),
      [
        [second, [a.conversationId]],
        [first, []],
      ],
    );
    store.execute(
      request({
        type: "section.assign",
        revision: 2,
        id: first,
        conversationId: b.conversationId,
      }),
    );
    store.execute(
      request({
        type: "conversation.update",
        conversationId: b.conversationId,
        hidden: true,
        pinned: true,
      }),
    );
    store.execute(
      request({
        type: "section.fold",
        revision: 3,
        id: first,
        collapsed: true,
      }),
    );
    store.execute(
      request({
        type: "section.move",
        revision: 4,
        id: first,
        beforeId: second,
      }),
    );
    store.close();
    store = new Store(path);
    assert.equal(store.views.snapshot({}).sidebar.sections[0]?.id, first);
    assert.equal(store.views.snapshot({}).sidebar.sections[0]?.collapsed, true);
    assert.deepEqual(
      store.views.snapshot({}).sidebar.sections[0]?.conversationIds,
      [b.conversationId],
    );
    const previous = store.views.snapshot({}).conversations;
    store.execute(request({ type: "section.delete", revision: 5, id: first }));
    assert.deepEqual(store.views.snapshot({}).conversations, previous);
    assert.deepEqual(
      store.views.snapshot({}).sidebar.sections.map((section) => section.id),
      [second],
    );
    assert.throws(
      () =>
        store.execute(
          request({
            type: "section.assign",
            revision: 6,
            id: first,
            conversationId: aConversationId,
          }),
        ),
      /分组已经不存在/,
    );
    assert.deepEqual(
      store.views.snapshot({}).sidebar.sections[0]?.conversationIds,
      [a.conversationId],
    );
    const job = store.execute(
      request({
        type: "entity.delete",
        kind: "bot",
        targetId: a.id,
        expectedName: "A",
      }),
    );
    assert.ok(job.id);
    assert.throws(
      () =>
        store.execute(
          request({
            type: "section.assign",
            revision: 6,
            id: null,
            conversationId: aConversationId,
          }),
        ),
      /正在清理|已不存在|删除正在处理/,
    );
    store.deletionOperations.deletionStart(job.id);
    store.deletionOperations.deletionPlan(job.id);
    store.deletionOperations.deletionComplete(job.id);
    assert.deepEqual(
      store.views.snapshot({}).sidebar.sections[0]?.conversationIds,
      [],
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("sidebar command contract rejects reserved, empty, oversized and unexpected inputs", () => {
  const valid = {
    type: "section.create",
    revision: 0,
    id: randomUUID(),
    name: "有效",
    conversationId: randomUUID(),
  };
  assert.equal(sectionCommandSchema.safeParse(valid).success, true);
  for (const change of [
    { name: "  " },
    { name: "字".repeat(81) },
    { id: "__agents__" },
    { revision: -1 },
    { path: "C:/" },
  ])
    assert.equal(
      sectionCommandSchema.safeParse({ ...valid, ...change }).success,
      false,
    );
});
