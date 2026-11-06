import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/chat/agent.js";
import { groupOutput } from "../src/chat/group-output.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
const command = (value: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command: value });

await test("group creation is atomic; member threads, incremental context and queued future input remain separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-groups-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const a = store.execute(
      command({ type: "bot.create", name: "A", description: "first" }),
    );
    const b = store.execute(
      command({ type: "bot.create", name: "B", description: "second" }),
    );
    assert.ok(a.id);
    assert.ok(b.id);
    const aId = a.id,
      bId = b.id;
    const start = command({
      type: "group.start",
      memberIds: [aId, bId],
      text: "FIRST_INPUT",
    });
    const created = store.execute(start);
    assert.deepEqual(store.execute(start), created);
    assert.ok(created.conversationId);
    assert.ok(created.id);
    const conversationId = created.conversationId;
    const group = store.views
      .snapshot({})
      .conversations.find((c) => c.id === conversationId)?.group;
    assert.ok(group);
    assert.throws(
      () =>
        store.execute(
          command({
            type: "group.update",
            conversationId,
            ...group,
            name: "changed",
          }),
        ),
      /讨论尚未结束/,
    );
    const count = store.views.snapshot({}).conversations.length;
    assert.throws(
      () =>
        store.execute(
          command({
            type: "group.start",
            memberIds: [aId, aId],
            text: "duplicate",
          }),
        ),
      /不同 Bot/,
    );
    assert.equal(store.views.snapshot({}).conversations.length, count);
    const parent = store.runs.claim();
    assert.ok(parent);
    const first = store.runs.nextGroupTurn(parent);
    assert.ok(first);
    assert.equal(first.botId, a.id);
    assert.equal(first.threadId, null);
    store.runs.setThread(first, "thread-A-group");
    store.execute(
      command({ type: "message.send", conversationId, text: "FUTURE_INPUT" }),
    );
    store.runs.output.writeText(first, "0:reply", "FIRST_ANSWER", true);
    store.runs.finishGroupTurn(first, "completed", null);
    store.runs.output.writeText(
      first,
      "0:late",
      "LATE_SHOULD_BE_IGNORED",
      true,
    );
    const second = store.runs.nextGroupTurn(parent);
    assert.ok(second);
    assert.equal(second.botId, b.id);
    assert.equal(second.threadId, null);
    assert.match(second.text, /FIRST_ANSWER/);
    assert.doesNotMatch(second.text, /FUTURE_INPUT|LATE_SHOULD_BE_IGNORED/);
    store.runs.setThread(second, "thread-B-group");
    store.runs.output.writeText(second, "1:reply", "SECOND_ANSWER", true);
    store.runs.finishGroupTurn(second, "completed", null);
    const nextA = store.runs.nextGroupTurn(parent);
    assert.ok(nextA);
    assert.equal(nextA.threadId, "thread-A-group");
    assert.match(nextA.text, /SECOND_ANSWER/);
    assert.doesNotMatch(nextA.text, /FUTURE_INPUT|FIRST_INPUT/);
    store.runs.finishGroupTurn(nextA, "skipped", null);
    const nextB = store.runs.nextGroupTurn(parent);
    assert.ok(nextB);
    assert.equal(nextB.threadId, "thread-B-group");
    store.runs.finishGroupTurn(nextB, "skipped", null);
    assert.equal(store.runs.nextGroupTurn(parent), null);
    store.runs.finish(parent.id, "completed", null);
    const future = store.runs.claim();
    assert.ok(future);
    const later = store.runs.nextGroupTurn(future);
    assert.ok(later);
    assert.match(later.text, /FUTURE_INPUT/);
    assert.doesNotMatch(later.text, /FIRST_INPUT/);
    store.execute(command({ type: "run.cancel", runId: future.id }));
    assert.equal(store.runs.nextGroupTurn(future), null);
    store.runs.finishGroupTurn(later, "cancelled", null);
    store.runs.finish(future.id, "cancelled", null);
    store.execute(
      command({
        type: "group.update",
        conversationId,
        ...group,
        name: "Renamed",
        memberIds: [bId],
      }),
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "group.update",
            conversationId,
            ...group,
            name: "stale",
          }),
        ),
      /已被更新/,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "message.send",
            conversationId,
            text: "wrong recipient",
            recipientIds: [aId],
          }),
        ),
      /只能选择/,
    );
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === a.conversationId)?.threadId,
      null,
    );
    assert.deepEqual(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.group?.memberIds,
      [bId],
    );
    assert.equal(
      store.views
        .snapshot({ conversationId })
        .messages.filter((m) => m.role === "assistant").length,
      2,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("group recovery never restarts an unknown member; failed members do not retry automatically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-group-recovery-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const a = store.execute(
      command({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      command({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.id);
    assert.ok(b.id);
    const aId = a.id,
      bId = b.id;
    const created = store.execute(
      command({ type: "group.start", memberIds: [aId, bId], text: "work" }),
    );
    assert.ok(created.conversationId);
    const parent = store.runs.claim();
    assert.ok(parent);
    const first = store.runs.nextGroupTurn(parent);
    assert.ok(first);
    store.runs.finishGroupTurn(first, "failed", "member unavailable");
    assert.equal(
      store.runs.getRun(parent.id)?.groupTurns[2]?.status,
      "cancelled",
    );
    const second = store.runs.nextGroupTurn(parent);
    assert.ok(second);
    store.runs.setThread(second, "persisted-B");
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(store.runs.getRun(parent.id)?.status, "unknown");
    assert.equal(
      store.runs.getRun(parent.id)?.groupTurns[1]?.status,
      "unknown",
    );
    assert.equal(
      store.runs.getRun(parent.id)?.groupTurns[3]?.status,
      "cancelled",
    );
    assert.equal(store.runs.nextGroupTurn(parent), null);
    assert.equal(store.runs.claim(), undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("pass marker stays out of messages while ordinary member text streams without duplication", () => {
  const events: AgentEvent[] = [];
  const output = groupOutput((event) => events.push(event));
  for (const text of ["[[AS", "TER_PASS", "]]"])
    output.accept({ type: "text", itemId: "pass", text, complete: false });
  output.accept({
    type: "text",
    itemId: "pass",
    text: "[[ASTER_PASS]]",
    complete: true,
  });
  assert.equal(events.length, 0);
  assert.equal(output.contributed, false);
  output.accept({
    type: "text",
    itemId: "answer",
    text: "真实",
    complete: false,
  });
  output.accept({
    type: "text",
    itemId: "answer",
    text: "回复",
    complete: false,
  });
  output.accept({
    type: "text",
    itemId: "answer",
    text: "真实回复",
    complete: true,
  });
  assert.equal(output.contributed, true);
  assert.deepEqual(
    events.map((e) => (e.type === "text" ? e.text : "")),
    ["真实", "回复", "真实回复"],
  );
});

await test("group attachment draft activates atomically and durable mentions route only the selected member", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-group-draft-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const a = store.execute(
      command({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      command({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.id);
    assert.ok(b.id);
    const aId = a.id,
      bId = b.id;
    const prepare = command({ type: "group.prepare", memberIds: [aId, bId] });
    const created = store.execute(prepare);
    assert.deepEqual(store.execute(prepare), created);
    assert.ok(created.conversationId);
    const conversationId = created.conversationId;
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.group?.draft,
      true,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "group.start",
            conversationId,
            memberIds: [aId, bId],
            text: "",
          }),
        ),
      /请输入/,
    );
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.group?.draft,
      true,
    );
    const file = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "first.txt" },
      Buffer.from("FIRST_ATTACHMENT"),
    );
    store.close();
    store = new Store(path);
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.draftAttachments[0]
        ?.id,
      file.id,
    );
    const start = command({
      type: "group.start",
      conversationId,
      memberIds: [b.id],
      text: "",
      attachmentIds: [file.id],
    });
    const result = store.execute(start);
    assert.deepEqual(store.execute(start), result);
    assert.ok(result.id);
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.group?.draft,
      false,
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    assert.equal(turn.botId, b.id);
    assert.equal(turn.attachments[0]?.id, file.id);
    store.runs.finishGroupTurn(turn, "skipped", null);
    assert.equal(store.runs.nextGroupTurn(parent), null);
    store.runs.finish(parent.id, "completed", null);
    assert.throws(
      () =>
        store.execute(
          command({
            type: "group.recipients",
            conversationId,
            recipientIds: [aId],
            text: "invalid",
          }),
        ),
      /当前群聊成员/,
    );
    store.execute(
      command({
        type: "group.recipients",
        conversationId,
        recipientIds: [b.id],
        text: "directed",
      }),
    );
    store.close();
    store = new Store(path);
    const saved = store.views
      .snapshot({})
      .conversations.find((c) => c.id === conversationId);
    assert.equal(saved?.draft, "directed");
    assert.deepEqual(saved?.group?.draftRecipientIds, [b.id]);
    const directed = store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "directed",
        recipientIds: [b.id],
      }),
    );
    assert.ok(directed.id);
    assert.deepEqual(
      store.runs.getRun(directed.id)?.groupTurns.map((t) => t.botId),
      [b.id, b.id],
    );
    assert.deepEqual(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.group
        ?.draftRecipientIds,
      [],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
