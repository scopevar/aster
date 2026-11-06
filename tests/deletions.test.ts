import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanWindowsFiles, ownedWorkspace } from "../src/deletion/files.js";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

const request = (command: Command) => ({
  id: randomUUID(),
  command,
});
function create(store: Store, name: string) {
  const bot = store.execute(
    request({ type: "bot.create", name, description: `private-${name}` }),
  );
  assert.ok(bot.id && bot.conversationId);
  return { id: bot.id, conversationId: bot.conversationId };
}
function finish(store: Store) {
  const job = store.runs.claim();
  assert.ok(job);
  if (store.runs.getRun(job.id)?.groupTurns.length) {
    let turn;
    while ((turn = store.runs.nextGroupTurn(job))) {
      store.runs.setThread(turn, randomUUID());
      store.runs.output.writeText(turn, randomUUID(), "shared-history", true);
      store.runs.finishGroupTurn(turn, "completed", null);
    }
  } else {
    store.runs.setThread(job, randomUUID());
    store.runs.output.writeText(job, randomUUID(), "private-history", true);
  }
  store.runs.finish(job.id, "completed", null);
  return job;
}

await test("Bot deletion revokes admission, preserves other members and shared frozen history, then purges private records atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-delete-store-")),
    path = join(dir, "db.sqlite");
  const store = new Store(path);
  try {
    const a = create(store, "A"),
      b = create(store, "B");
    const skill = randomUUID();
    store.execute(
      request({
        type: "skill.save",
        id: skill,
        revision: 0,
        botId: a.id,
        name: "shared-skill",
        description: "original",
        body: "frozen-body",
      }),
    );
    store.execute(
      request({
        type: "message.send",
        conversationId: a.conversationId,
        text: "private-input",
      }),
    );
    finish(store);
    const second = store.execute(
      request({ type: "conversation.create", botId: a.id }),
    );
    assert.ok(second.conversationId);
    store.files.registerAttachment(
      {
        id: randomUUID(),
        conversationId: second.conversationId,
        name: "private.txt",
      },
      Buffer.from("private-attachment"),
    );
    store.execute(
      request({
        type: "memory.save",
        id: randomUUID(),
        revision: 0,
        scope: { botId: a.id, conversationId: null },
        topic: "private",
        content: "private-memory",
      }),
    );
    const group = store.execute(
      request({
        type: "group.start",
        memberIds: [a.id, b.id],
        text: "shared-input",
        skills: [{ id: skill, botId: a.id, revision: 1 }],
      }),
    );
    assert.ok(group.conversationId);
    finish(store);
    const sharedBefore = store.views.snapshot({
      conversationId: group.conversationId,
    }).messages;
    store.execute(
      request({
        type: "message.send",
        conversationId: a.conversationId,
        text: "pending-delete",
      }),
    );
    const active = store.runs.claim();
    assert.ok(active);
    const pending = store.toolOperations.questionRequest(active, "question", {
      prompt: "question",
      options: ["one", "two"],
    });
    const deleting = request({
      type: "entity.delete",
      kind: "bot",
      targetId: a.id,
      expectedName: "A",
    });
    const begun = store.execute(deleting);
    assert.ok(begun.id);
    assert.equal(store.runs.getRun(active.id)?.status, "cancelling");
    assert.equal(
      store.views.snapshot({}).bots.find((x) => x.id === a.id)?.lifecycle,
      "deleting",
    );
    assert.throws(
      () =>
        store.execute(request({ type: "conversation.create", botId: a.id })),
      /清理/,
    );
    assert.throws(
      () =>
        store.files.registerAttachment(
          {
            id: randomUUID(),
            conversationId: a.conversationId,
            name: "late.txt",
          },
          Buffer.from("late"),
        ),
      /清理/,
    );
    assert.throws(
      () =>
        store.toolOperations.skillToolRequest(active, {
          callId: "late",
          operation: { action: "list" },
        }),
      /结束/,
    );
    assert.throws(
      () => store.deletionOperations.deletionPlan(begun.id!),
      /停止/,
    );
    store.runs.finish(active.id, "cancelled", null);
    store.deletionOperations.deletionStart(begun.id);
    const plan = store.deletionOperations.deletionPlan(begun.id);
    assert.deepEqual(
      new Set(plan.conversations),
      new Set([a.conversationId, second.conversationId]),
    );
    assert.equal(plan.threads[0]?.all, true);
    store.deletionOperations.deletionComplete(begun.id);
    assert.deepEqual(store.execute(deleting), begun);
    const snapshot = store.views.snapshot({
      conversationId: group.conversationId,
    });
    assert.deepEqual(snapshot.messages, sharedBefore);
    assert.deepEqual(
      snapshot.conversations.find((x) => x.id === group.conversationId)?.group
        ?.memberIds,
      [b.id],
    );
    assert.equal(
      snapshot.bots.find((x) => x.id === a.id)?.name,
      "已删除的 Bot",
    );
    assert.equal(
      snapshot.bots.find((x) => x.id === b.id)?.description,
      "private-B",
    );
    assert.equal(
      store.skillContent({ id: skill, botId: a.id, revision: 1 }).body,
      "frozen-body",
    );
    assert.ok(
      snapshot.deletedClientKeys.includes(`question-draft:${pending.id}`),
    );
    assert.equal(
      store.views.snapshot({ conversationId: a.conversationId }).messages
        .length,
      0,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(
        db.prepare("SELECT count(*) n FROM skills WHERE botId=?").get(a.id)?.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM attachments").get()?.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM memories WHERE botId=?").get(a.id)
          ?.n,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("group deletion retains private data, replays an interrupted plan and rolls back a failed final purge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-delete-group-")),
    path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const a = create(store, "A"),
      b = create(store, "B");
    store.execute(
      request({
        type: "message.send",
        conversationId: a.conversationId,
        text: "keep-private",
      }),
    );
    finish(store);
    const before = store.views.snapshot({
      conversationId: a.conversationId,
    }).messages;
    const group = store.execute(
      request({
        type: "group.start",
        memberIds: [a.id, b.id],
        text: "delete-group",
      }),
    );
    assert.ok(group.conversationId);
    finish(store);
    const view = store.views
      .snapshot({})
      .conversations.find((c) => c.id === group.conversationId)?.group;
    assert.ok(view);
    const begun = store.execute(
      request({
        type: "entity.delete",
        kind: "group",
        targetId: group.conversationId,
        expectedName: view.name,
      }),
    );
    assert.ok(begun.id);
    assert.throws(
      () =>
        store.execute(
          request({
            type: "entity.delete",
            kind: "bot",
            targetId: a.id,
            expectedName: "A",
          }),
        ),
      /清理/,
    );
    store.deletionOperations.deletionStart(begun.id);
    const plan = store.deletionOperations.deletionPlan(begun.id);
    assert.equal(plan.threads.length, 2);
    assert.equal(plan.botId, null);
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(store.deletionOperations.deletionNext()?.id, begun.id);
    store.deletionOperations.deletionStart(begun.id);
    assert.deepEqual(store.deletionOperations.deletionPlan(begun.id), plan);
    const fault = new DatabaseSync(path);
    fault.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'injected delete failure'); END;",
    );
    fault.close();
    assert.throws(
      () => store.deletionOperations.deletionComplete(begun.id!),
      /injected/,
    );
    store.deletionOperations.deletionFail(begun.id, "injected delete failure");
    assert.equal(store.views.snapshot({}).deletions[0]?.status, "failed");
    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_delete");
    repair.close();
    store.execute(request({ type: "deletion.retry", id: begun.id }));
    store.deletionOperations.deletionStart(begun.id);
    store.deletionOperations.deletionComplete(begun.id);
    const after = store.views.snapshot({ conversationId: a.conversationId });
    assert.deepEqual(after.messages, before);
    assert.equal(after.bots.filter((b) => b.lifecycle === "active").length, 2);
    assert.equal(after.conversations.length, 2);
    assert.ok(
      after.deletedClientKeys.includes(
        `memory-editor:${a.id}:${group.conversationId}`,
      ),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("owned file cleanup rejects redirected roots and caches, never follows child links, and can be repeated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-delete-files-")),
    root = join(dir, "workspaces"),
    outside = join(dir, "outside"),
    id = randomUUID(),
    other = randomUUID();
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "KEEP");
  try {
    await symlink(
      outside,
      join(root, id),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(ownedWorkspace(root, id), /其他位置/);
    await rm(join(root, id));
    await mkdir(join(root, id));
    await symlink(
      outside,
      join(root, id, "child-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(root, other));
    await symlink(
      outside,
      join(root, other, "attachments"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const plan = {
      conversations: [],
      threads: [],
      caches: [],
      botId: id,
    };
    await assert.rejects(
      cleanWindowsFiles(
        root,
        {
          ...plan,
          caches: [{ botId: other, fileName: `${randomUUID()}.txt` }],
        },
        new AbortController().signal,
      ),
      /其他位置/,
    );
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "KEEP");
    await cleanWindowsFiles(root, plan, new AbortController().signal);
    await cleanWindowsFiles(root, plan, new AbortController().signal);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "KEEP");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
