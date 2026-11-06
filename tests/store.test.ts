import { maxDatabaseVersion } from "../src/shared/backup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { emojiCatalog } from "../src/presentation/emoji.js";
import { emojiSchema } from "../src/shared/emoji.js";
import { Store } from "../src/storage/store.js";

function command(command: Command) {
  return envelopeSchema.parse({ id: randomUUID(), command });
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aster-store-"));
  const store = new Store(join(directory, "db.sqlite"));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function bot(store: Store) {
  const id = store.execute(
    command({ type: "bot.create", name: "Test", description: "" }),
  ).conversationId;
  assert.ok(id);
  return id;
}
await test("shortcut prompts preserve composer text and quote, deduplicate after reopen and do not claim draft content", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    f.store.execute(
      command({ type: "message.send", conversationId, text: "seed" }),
    );
    const first = f.store.runs.claim();
    assert.ok(first);
    f.store.runs.output.writeText(first, "answer", "reply to quote", true);
    f.store.runs.finish(first.id, "completed", null);
    const reply = f.store.views.snapshot({ conversationId }).messages.at(-1);
    assert.ok(reply);
    f.store.execute(
      command({ type: "draft.save", conversationId, text: "unfinished draft" }),
    );
    f.store.execute(
      command({ type: "reply.save", conversationId, messageId: reply.id }),
    );
    const attachment = f.store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "unsent.txt" },
      Buffer.from("private unsent attachment"),
    );
    const owner = f.store.views
      .snapshot({})
      .conversations.find((c) => c.id === conversationId)?.botId;
    assert.ok(owner);
    const skillId = randomUUID();
    f.store.execute(
      command({
        type: "skill.save",
        id: skillId,
        botId: owner,
        revision: 0,
        name: "Unsent skill",
        description: "Reserved for composer",
        body: "Only use with the composer message.",
      }),
    );
    f.store.execute(
      command({
        type: "skills.select",
        conversationId,
        references: [{ id: skillId, botId: owner, revision: 1 }],
        text: "unfinished draft",
      }),
    );
    const request = command({
      type: "message.prompt",
      conversationId,
      text: "create a draft template",
    });
    const accepted = f.store.execute(request);
    const reopened = new Store(join(f.directory, "db.sqlite"));
    try {
      assert.deepEqual(reopened.execute(request), accepted);
    } finally {
      reopened.close();
    }
    const snapshot = f.store.views.snapshot({ conversationId });
    assert.equal(
      snapshot.conversations.find((c) => c.id === conversationId)?.draft,
      "unfinished draft",
    );
    assert.equal(
      snapshot.conversations.find((c) => c.id === conversationId)?.replyTo?.id,
      reply.id,
    );
    assert.equal(
      snapshot.messages.filter((m) => m.text === "create a draft template")
        .length,
      1,
    );
    assert.equal(snapshot.messages.at(-1)?.replyTo, null);
    assert.deepEqual(snapshot.messages.at(-1)?.attachments, []);
    assert.equal(
      snapshot.conversations.find((c) => c.id === conversationId)
        ?.draftAttachments[0]?.id,
      attachment.id,
    );
    assert.equal(
      snapshot.conversations.find((c) => c.id === conversationId)
        ?.draftSkills[0]?.id,
      skillId,
    );
    assert.deepEqual(snapshot.messages.at(-1)?.skills, []);
    const other = bot(f.store);
    f.store.execute(
      command({
        type: "draft.save",
        conversationId: other,
        text: "other draft",
      }),
    );
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "message.prompt",
            conversationId: randomUUID(),
            text: "invalid",
          }),
        ),
      /不存在/,
    );
    assert.equal(
      f.store.views.snapshot({}).conversations.find((c) => c.id === other)
        ?.draft,
      "other draft",
    );
  } finally {
    f.close();
  }
});
await test("read watermarks cannot consume later replies, cross conversations or a newer manual unread mark", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    f.store.execute(
      command({ type: "message.send", conversationId, text: "hello" }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    assert.equal(
      f.store.views.snapshot({}).conversations[0]?.activityStatus,
      "running",
    );
    f.store.runs.output.writeText(job, "first", "first", true);
    const first = f.store.views.snapshot({ conversationId }).messages.at(-1);
    assert.ok(first);
    assert.equal(f.store.views.snapshot({}).conversations[0]?.unreadCount, 1);
    f.store.runs.output.writeText(job, "second", "later reply", true);
    f.store.execute(
      command({
        type: "conversation.read",
        conversationId,
        through: first.sequence,
        readVersion: 0,
      }),
    );
    assert.equal(f.store.views.snapshot({}).conversations[0]?.unreadCount, 1);
    f.store.execute(command({ type: "conversation.unread", conversationId }));
    const last = f.store.views.snapshot({ conversationId }).messages.at(-1);
    assert.ok(last);
    f.store.execute(
      command({
        type: "conversation.read",
        conversationId,
        through: last.sequence,
        readVersion: 0,
      }),
    );
    assert.equal(
      f.store.views.snapshot({}).conversations[0]?.markedUnread,
      true,
    );
    f.store.execute(
      command({
        type: "conversation.read",
        conversationId,
        through: last.sequence,
        readVersion: 1,
      }),
    );
    assert.equal(
      f.store.views.snapshot({}).conversations[0]?.markedUnread,
      false,
    );
    assert.equal(f.store.views.snapshot({}).conversations[0]?.unreadCount, 0);
    const other = bot(f.store);
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "conversation.read",
            conversationId: other,
            through: last.sequence,
            readVersion: 0,
          }),
        ),
      /不属于/,
    );
    f.store.execute(
      command({ type: "conversation.unread", conversationId: other }),
    );
    f.store.execute(
      command({
        type: "conversation.read",
        conversationId: other,
        through: 0,
        readVersion: 1,
      }),
    );
    assert.equal(
      f.store.views.snapshot({}).conversations.find((c) => c.id === other)
        ?.markedUnread,
      false,
    );
    f.store.runs.finish(job.id, "completed", null);
    assert.equal(
      f.store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.activityStatus,
      null,
    );
    const reopened = new Store(join(f.directory, "db.sqlite"));
    try {
      assert.equal(
        reopened.views
          .snapshot({})
          .conversations.find((c) => c.id === conversationId)?.lastReadSequence,
        last.sequence,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
await test("tools retain real lifecycle, bound output and recover interrupted calls without replay", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const identity = f.store.views.snapshot({}).bots[0];
    assert.ok(identity);
    f.store.execute(
      command({
        type: "bot.preferences",
        botId: identity.id,
        name: "Research",
        description: "Be brief",
        tags: "研究",
        language: "en",
      }),
    );
    f.store.execute(
      command({ type: "message.send", conversationId, text: "read" }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    assert.match(job.description, /preference: en/);
    const running = {
      kind: "command",
      command: "read example.txt",
      cwd: "/workspace",
      status: "running",
      output: "",
      truncated: false,
      exitCode: null,
      durationMs: null,
    } as const;
    f.store.runs.output.writeTool(job, "tool-1", running);
    f.store.runs.output.appendToolOutput(job, "tool-1", "x".repeat(70000));
    assert.equal(
      f.store.views.snapshot({ conversationId }).messages.at(-1)?.tool?.output
        .length,
      65536,
    );
    assert.equal(
      f.store.views.snapshot({ conversationId }).messages.at(-1)?.tool
        ?.truncated,
      true,
    );
    f.store.runs.output.writeTool(job, "tool-1", {
      ...running,
      status: "completed",
      output: "final",
      exitCode: 0,
      durationMs: 45,
    });
    f.store.runs.output.writeTool(job, "tool-1", running);
    f.store.runs.output.appendToolOutput(job, "tool-1", "stale");
    assert.equal(
      f.store.views.snapshot({ conversationId }).messages.at(-1)?.tool?.output,
      "final",
    );
    assert.equal(f.store.views.snapshot({ conversationId }).messages.length, 2);
    f.store.runs.output.writeTool(job, "tool-2", running);
    f.store.recover();
    const state = f.store.views.snapshot({ conversationId });
    assert.equal(state.messages.at(-1)?.tool?.status, "unknown");
    assert.equal(state.messages[1]?.tool?.status, "completed");
    f.store.runs.output.writeTool(job, "tool-2", {
      ...running,
      status: "completed",
    });
    assert.equal(
      f.store.views.snapshot({ conversationId }).messages.at(-1)?.tool?.status,
      "unknown",
    );
    assert.equal(f.store.runs.claim(), undefined);
  } finally {
    f.close();
  }
});
await test("reply drafts survive restart, enforce scope and freeze the sent quote with atomic enqueue", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const other = bot(f.store);
    f.store.execute(
      command({ type: "message.send", conversationId, text: "original" }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    f.store.runs.output.writeText(job, "answer", "Cedar47", false);
    const original = f.store.views.snapshot({ conversationId }).messages.at(-1);
    assert.ok(original);
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "reply.save",
            conversationId: other,
            messageId: original.id,
          }),
        ),
      /不属于当前会话/,
    );
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "message.send",
            conversationId: other,
            text: "bad",
            replyToId: original.id,
          }),
        ),
      /不属于当前会话/,
    );
    assert.equal(
      f.store.views.snapshot({ conversationId: other }).runs.length,
      0,
    );
    f.store.execute(
      command({ type: "reply.save", conversationId, messageId: original.id }),
    );
    f.store.execute(
      command({ type: "draft.save", conversationId, text: "which code?" }),
    );
    const secondReader = new Store(join(f.directory, "db.sqlite"));
    try {
      const restored = secondReader.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId);
      assert.equal(restored?.replyTo?.id, original.id);
      assert.equal(restored?.draft, "which code?");
    } finally {
      secondReader.close();
    }
    const send = command({
      type: "message.send",
      conversationId,
      text: "which code?",
      replyToId: original.id,
    });
    const result = f.store.execute(send);
    assert.equal(result.id, job.id);
    assert.deepEqual(f.store.execute(send), result);
    const steer = f.store.runs.takeSteer(job);
    assert.ok(steer);
    assert.ok(steer.text.includes('"text":"Cedar47"'));
    assert.ok(steer.text.endsWith("which code?"));
    f.store.runs.output.writeText(job, "answer", " updated", false);
    f.store.runs.finish(job.id, "completed", null);
    const state = f.store.views.snapshot({ conversationId });
    assert.equal(state.messages.at(-1)?.replyTo?.text, "Cedar47");
    assert.equal(
      state.conversations.find((c) => c.id === conversationId)?.replyTo,
      null,
    );
    assert.equal(
      state.conversations.find((c) => c.id === conversationId)?.draft,
      "",
    );
    assert.equal(
      state.conversations.find((c) => c.id === conversationId)?.preview,
      "which code?",
    );
    assert.equal(f.store.runs.claim(), undefined);
  } finally {
    f.close();
  }
});
await test("full emoji responses validate, remain idempotent and retain a bounded recent history", () => {
  for (const entry of emojiCatalog)
    assert.equal(emojiSchema.parse(entry.unicode), entry.unicode);
  assert.equal(emojiSchema.parse("❤"), "❤️");
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    f.store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "reaction target",
      }),
    );
    const messageId = f.store.views.snapshot({ conversationId }).messages[0]
      ?.id;
    assert.ok(messageId);
    assert.throws(() =>
      command({
        type: "reaction.set",
        messageId,
        emoji: "not an emoji",
        active: true,
      }),
    );
    const entries = emojiCatalog.slice(0, 30).map((e) => e.unicode);
    for (const emoji of entries)
      f.store.execute(
        command({ type: "reaction.set", messageId, emoji, active: true }),
      );
    const recent = f.store.views.snapshot({}).recentEmojis;
    assert.deepEqual(recent, [...entries].reverse().slice(0, 24));
    const request = command({
      type: "reaction.set",
      messageId,
      emoji: "🚀",
      active: true,
    });
    f.store.execute(request);
    f.store.execute(request);
    assert.equal(
      f.store.views
        .snapshot({ conversationId })
        .messages[0]?.reactions.find((r) => r.emoji === "🚀")?.count,
      1,
    );
    f.store.execute(
      command({ type: "reaction.set", messageId, emoji: "🚀", active: false }),
    );
    assert.equal(
      f.store.views
        .snapshot({ conversationId })
        .messages[0]?.reactions.some((r) => r.emoji === "🚀"),
      false,
    );
    assert.equal(f.store.views.snapshot({}).recentEmojis[0], "🚀");
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "reaction.set",
            messageId: randomUUID(),
            emoji: "🏠",
            active: true,
          }),
        ),
      /不存在/,
    );
    assert.equal(f.store.views.snapshot({}).recentEmojis[0], "🚀");
    const job = f.store.runs.claim();
    assert.ok(job);
    assert.throws(
      () =>
        f.store.runs.output.writeText(
          { ...job, conversationId: randomUUID() },
          "wrong",
          "bad",
          true,
        ),
      /运行与会话不匹配/,
    );
    assert.equal(f.store.views.snapshot({ conversationId }).messages.length, 1);
  } finally {
    f.close();
  }
});
await test("message acceptance is atomic and idempotent; ID reuse with altered input fails", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store),
      request = command({
        type: "message.send",
        conversationId,
        text: "Hello",
      });
    const first = f.store.execute(request);
    assert.deepEqual(f.store.execute(request), first);
    assert.equal(f.store.views.snapshot({ conversationId }).messages.length, 1);
    assert.throws(
      () =>
        f.store.execute({
          ...request,
          command: { type: "message.send", conversationId, text: "Changed" },
        }),
      /不同操作/,
    );
    const invalid = command({
      type: "message.send",
      conversationId: randomUUID(),
      text: "orphan",
    });
    assert.throws(() => f.store.execute(invalid), /不存在/);
    assert.equal(f.store.views.snapshot({ conversationId }).runs.length, 1);
  } finally {
    f.close();
  }
});
await test("cancel queued work before execution and ignore stale text after termination", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const id = f.store.execute(
      command({ type: "message.send", conversationId, text: "one" }),
    ).id;
    assert.ok(id);
    f.store.execute(command({ type: "run.cancel", runId: id }));
    assert.equal(f.store.runs.claim(), undefined);
    const next = f.store.execute(
      command({ type: "message.send", conversationId, text: "two" }),
    ).id;
    assert.ok(next);
    const job = f.store.runs.claim();
    assert.ok(job);
    f.store.runs.output.writeText(job, "item", "partial", false);
    f.store.runs.finish(job.id, "cancelled", null);
    f.store.runs.output.writeText(job, "item", " stale", false);
    assert.equal(
      f.store.views.snapshot({ conversationId }).messages.at(-1)?.text,
      "partial",
    );
  } finally {
    f.close();
  }
});
await test("reopen preserves history and reactions while marking interrupted execution unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-recovery-"));
  let store = new Store(join(directory, "db.sqlite"));
  try {
    const conversationId = bot(store);
    store.execute(
      command({ type: "message.send", conversationId, text: "keep" }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    store.runs.output.writeText(job, "item", "partial", false);
    store.runs.setThread(job, "codex-thread");
    const messageId = store.views.snapshot({ conversationId }).messages[0]?.id;
    assert.ok(messageId);
    const react = command({
      type: "reaction.set",
      messageId,
      emoji: "👍",
      active: true,
    });
    store.execute(react);
    store.execute(react);
    store.close();
    store = new Store(join(directory, "db.sqlite"));
    store.recover();
    const snapshot = store.views.snapshot({ conversationId });
    assert.equal(snapshot.runs[0]?.status, "unknown");
    assert.equal(snapshot.messages[0]?.reactions[0]?.count, 1);
    assert.equal(snapshot.conversations[0]?.threadId, "codex-thread");
    assert.equal(store.runs.claim(), undefined);
    store.execute(
      command({ type: "reaction.set", messageId, emoji: "👍", active: false }),
    );
    assert.deepEqual(
      store.views.snapshot({ conversationId }).messages[0]?.reactions,
      [],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
await test("pagination retains all messages, stable ordering, and queue capacity rolls back", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    for (let i = 0; i < 105; i++) {
      f.store.execute(
        command({ type: "message.send", conversationId, text: String(i) }),
      );
      const job = f.store.runs.claim();
      assert.ok(job);
      f.store.runs.finish(job.id, "completed", null);
    }
    const latest = f.store.views.snapshot({ conversationId });
    assert.equal(latest.messages.length, 100);
    assert.equal(latest.hasOlder, true);
    const before = latest.messages[0]?.sequence;
    assert.ok(before);
    const older = f.store.views.snapshot({ conversationId, before });
    assert.equal(older.messages.length, 5);
    assert.equal(older.hasOlder, false);
    assert.equal(older.messages[0]?.text, "0");
    const botId = f.store.views.snapshot({}).bots[0]?.id;
    assert.ok(botId);
    for (let i = 0; i < 100; i++) {
      const extra = f.store.execute(
        command({ type: "conversation.create", botId }),
      ).conversationId;
      assert.ok(extra);
      f.store.execute(
        command({
          type: "message.send",
          conversationId: extra,
          text: "queued",
        }),
      );
    }
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "message.send",
            conversationId,
            text: "over capacity",
          }),
        ),
      /队列已满/,
    );
  } finally {
    f.close();
  }
});

await test("one Bot has independent conversation drafts, model threads, histories and cancellation", () => {
  const f = fixture();
  try {
    const created = f.store.execute(
      command({
        type: "bot.create",
        name: "Shared identity",
        description: "original",
      }),
    );
    assert.ok(created.id && created.conversationId);
    const request = command({ type: "conversation.create", botId: created.id });
    const second = f.store.execute(request);
    assert.deepEqual(f.store.execute(request), second);
    assert.ok(second.conversationId);
    assert.equal(f.store.views.snapshot({}).conversations.length, 2);
    const firstId = created.conversationId,
      secondId = second.conversationId;
    for (const id of [firstId, secondId])
      f.store.execute(
        command({
          type: "draft.save",
          conversationId: id,
          text: `draft:${id}`,
        }),
      );
    f.store.execute(
      command({ type: "message.send", conversationId: firstId, text: "first" }),
    );
    const first = f.store.runs.claim();
    assert.ok(first);
    assert.equal(first.threadId, null);
    f.store.runs.setThread(first, "thread-first");
    f.store.runs.output.writeText(first, "item", "first response", true);
    f.store.runs.finish(first.id, "completed", null);
    f.store.execute(
      command({
        type: "bot.update",
        botId: created.id,
        name: "Renamed",
        description: "shared update",
      }),
    );
    f.store.execute(
      command({
        type: "message.send",
        conversationId: secondId,
        text: "second",
      }),
    );
    const next = f.store.runs.claim();
    assert.ok(next);
    assert.equal(next.threadId, null);
    assert.equal(next.description, "shared update");
    assert.equal(next.botId, first.botId);
    f.store.runs.setThread(next, "thread-second");
    f.store.execute(command({ type: "run.cancel", runId: next.id }));
    f.store.runs.finish(next.id, "cancelled", null);
    f.store.runs.setThread(next, "stale-thread");
    const a = f.store.views.snapshot({ conversationId: firstId }),
      b = f.store.views.snapshot({ conversationId: secondId });
    assert.deepEqual(
      a.messages.map((m) => m.text),
      ["first", "first response"],
    );
    assert.deepEqual(
      b.messages.map((m) => m.text),
      ["second"],
    );
    assert.equal(a.runs[0]?.status, "completed");
    assert.equal(b.runs[0]?.status, "cancelled");
    assert.equal(
      a.conversations.find((c) => c.id === firstId)?.threadId,
      "thread-first",
    );
    assert.equal(
      b.conversations.find((c) => c.id === secondId)?.threadId,
      "thread-second",
    );
    f.store.execute(
      command({
        type: "draft.save",
        conversationId: secondId,
        text: "second draft",
      }),
    );
    assert.equal(
      f.store.views.snapshot({}).conversations.find((c) => c.id === firstId)
        ?.draft,
      "",
    );
    assert.equal(
      f.store.views.snapshot({}).conversations.find((c) => c.id === secondId)
        ?.draft,
      "second draft",
    );
  } finally {
    f.close();
  }
});

await test("a failed private run retries the same user message and refuses unknown, grouped, or side-effecting runs", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const sent = f.store.execute(
      command({ type: "message.send", conversationId, text: "again" }),
    );
    assert.ok(sent.id);
    const runId = sent.id;
    const job = f.store.runs.claim();
    assert.ok(job);
    f.store.runs.setThread(job, "thread-keep");
    f.store.runs.setTurn(job, "turn-old");
    f.store.runs.output.writeText(job, "item", "partial", false);
    f.store.runs.finish(job.id, "failed", "boom");
    const before = f.store.views.snapshot({ conversationId });
    const user = before.messages.find((message) => message.role === "user");
    const assistant = before.messages.find(
      (message) => message.role === "assistant",
    );
    assert.ok(user && assistant);
    f.store.execute(
      command({
        type: "reaction.set",
        messageId: user.id,
        emoji: "👍",
        active: true,
      }),
    );
    f.store.execute(
      command({
        type: "reaction.set",
        messageId: assistant.id,
        emoji: "👎",
        active: true,
      }),
    );
    f.store.execute(
      command({
        type: "reply.save",
        conversationId,
        messageId: assistant.id,
      }),
    );
    const retry = command({ type: "run.retry", runId: sent.id });
    assert.deepEqual(f.store.execute(retry), { id: sent.id });
    assert.deepEqual(f.store.execute(retry), { id: sent.id });
    const retried = f.store.views.snapshot({ conversationId });
    assert.deepEqual(
      retried.messages.map((message) => message.text),
      ["again"],
    );
    assert.equal(retried.messages[0]?.reactions[0]?.emoji, "👍");
    assert.equal(retried.runs[0]?.status, "queued");
    assert.equal(retried.runs[0]?.error, null);
    assert.equal(retried.runs[0]?.turnId, null);
    assert.equal(retried.conversations[0]?.threadId, "thread-keep");
    assert.equal(retried.conversations[0]?.replyTo, null);
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId })),
      /只有失败的运行可以重试/,
    );
    const again = f.store.runs.claim();
    assert.ok(again);
    assert.equal(again.id, runId);
    assert.equal(again.text, "again");
    assert.equal(again.threadId, "thread-keep");
    f.store.runs.finish(again.id, "unknown", "结果尚未核实。");
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId })),
      /结果未知/,
    );
    const blocked = f.store.execute(
      command({ type: "message.send", conversationId, text: "tool" }),
    ).id;
    assert.ok(blocked);
    const toolJob = f.store.runs.claim();
    assert.ok(toolJob);
    f.store.runs.output.writeTool(toolJob, "tool-1", {
      kind: "command",
      command: "read example.txt",
      cwd: "/workspace",
      status: "failed",
      output: "",
      truncated: false,
      exitCode: 1,
      durationMs: 1,
    });
    f.store.runs.finish(toolJob.id, "failed", "tool failed");
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId: blocked })),
      /副作用/,
    );
    assert.throws(
      () =>
        f.store.execute(command({ type: "run.retry", runId: randomUUID() })),
      /不存在/,
    );
    const a = f.store.execute(
      command({ type: "bot.create", name: "A", description: "first" }),
    );
    const b = f.store.execute(
      command({ type: "bot.create", name: "B", description: "second" }),
    );
    assert.ok(a.id && b.id);
    const group = f.store.execute(
      command({
        type: "group.start",
        memberIds: [a.id, b.id],
        text: "group",
      }),
    );
    assert.ok(group.id);
    const groupId = group.id;
    const parent = f.store.runs.claim();
    assert.ok(parent);
    f.store.runs.finish(parent.id, "failed", "member failed");
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId: groupId })),
      /群聊/,
    );
    const held = f.store.execute(
      command({ type: "message.send", conversationId, text: "held" }),
    ).id;
    assert.ok(held);
    const heldJob = f.store.runs.claim();
    assert.ok(heldJob);
    assert.equal(heldJob.id, held);
    f.store.runs.finish(heldJob.id, "failed", "full");
    const owner = f.store.views
      .snapshot({})
      .conversations.find((item) => item.id === conversationId)?.botId;
    assert.ok(owner);
    for (let i = 0; i < 100; i++) {
      const extra = f.store.execute(
        command({ type: "conversation.create", botId: owner }),
      ).conversationId;
      assert.ok(extra);
      f.store.execute(
        command({
          type: "message.send",
          conversationId: extra,
          text: "queued",
        }),
      );
    }
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId: held })),
      /队列已满/,
    );
  } finally {
    f.close();
  }
});

await test("settling a private turn completes only when no follow-up is waiting", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const sent = f.store.execute(
      command({ type: "message.send", conversationId, text: "alpha" }),
    );
    assert.ok(sent.id);
    const job = f.store.runs.claim();
    assert.ok(job);
    f.store.execute(
      command({ type: "message.send", conversationId, text: "beta" }),
    );
    const steer = f.store.runs.settlePrivateTurn(job);
    assert.equal(steer.action, "steer");
    if (steer.action !== "steer") return;
    assert.equal(steer.text, "beta");
    assert.equal(f.store.runs.getRun(job.id)?.status, "running");
    const done = f.store.runs.settlePrivateTurn(job);
    assert.equal(done.action, "completed");
    assert.equal(f.store.runs.getRun(job.id)?.status, "completed");
    assert.equal(f.store.runs.claim(), undefined);
  } finally {
    f.close();
  }
});

await test("a private queued or running run absorbs the next instruction", () => {
  const f = fixture();
  try {
    const conversationId = bot(f.store);
    const first = f.store.execute(
      command({ type: "message.send", conversationId, text: "hello" }),
    );
    assert.ok(first.id);
    const runId = first.id;
    f.store.execute(
      command({ type: "draft.save", conversationId, text: "scratch" }),
    );
    const second = f.store.execute(
      command({ type: "message.send", conversationId, text: "more" }),
    );
    assert.equal(second.id, runId);
    assert.equal(
      f.store.views
        .snapshot({})
        .conversations.find((item) => item.id === conversationId)?.draft,
      "",
    );
    assert.equal(f.store.views.snapshot({ conversationId }).runs.length, 1);
    const job = f.store.runs.claim();
    assert.ok(job);
    assert.equal(job.id, runId);
    assert.equal(job.text, "hello\n用户追加的指令：\nmore");
    const later = f.store.execute(
      command({ type: "message.send", conversationId, text: "later" }),
    );
    assert.equal(later.id, runId);
    f.store.execute(
      command({ type: "draft.save", conversationId, text: "keep" }),
    );
    const question = f.store.toolOperations.questionRequest(job, "steer-q", {
      prompt: "继续吗",
      options: ["是", "否"],
    });
    const answered = f.store.execute(
      command({
        type: "question.answer",
        id: question.id,
        conversationId,
        answer: { type: "custom", text: "Yes please" },
      }),
    );
    assert.equal(answered.id, runId);
    assert.equal(
      f.store.views
        .snapshot({})
        .conversations.find((item) => item.id === conversationId)?.draft,
      "keep",
    );
    const steer = f.store.runs.takeSteer(job);
    assert.ok(steer);
    assert.match(steer.text, /用户正在引用/);
    assert.match(steer.text, /later\n用户追加的指令：\n/);
    assert.match(steer.text, /Yes please/);
    assert.equal(f.store.runs.takeSteer(job), null);
    f.store.execute(command({ type: "run.cancel", runId }));
    const fresh = f.store.execute(
      command({ type: "message.send", conversationId, text: "fresh" }),
    );
    assert.ok(fresh.id);
    assert.notEqual(fresh.id, runId);
    f.store.runs.finish(job.id, "cancelled", null);
    const freshJob = f.store.runs.claim();
    assert.equal(freshJob?.id, fresh.id);
    assert.equal(freshJob?.text, "fresh");
    assert.ok(freshJob);
    f.store.runs.finish(freshJob.id, "cancelled", null);
    const done = f.store.execute(
      command({ type: "message.send", conversationId, text: "done" }),
    );
    assert.ok(done.id);
    const doneJob = f.store.runs.claim();
    assert.equal(doneJob?.id, done.id);
    assert.ok(doneJob);
    f.store.runs.finish(doneJob.id, "completed", null);
    const next = f.store.execute(
      command({ type: "message.send", conversationId, text: "next" }),
    );
    assert.ok(next.id);
    const unknownId = next.id;
    assert.notEqual(unknownId, done.id);
    const nextJob = f.store.runs.claim();
    assert.ok(nextJob);
    f.store.runs.finish(nextJob.id, "unknown", "结果尚未核实。");
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId: unknownId })),
      /结果未知/,
    );
    const alpha = f.store.execute(
      command({ type: "bot.create", name: "A", description: "first" }),
    );
    const beta = f.store.execute(
      command({ type: "bot.create", name: "B", description: "second" }),
    );
    assert.ok(alpha.id && beta.id);
    const group = f.store.execute(
      command({
        type: "group.start",
        memberIds: [alpha.id, beta.id],
        text: "group",
      }),
    );
    assert.ok(group.id && group.conversationId);
    const again = f.store.execute(
      command({
        type: "message.send",
        conversationId: group.conversationId,
        text: "separate",
      }),
    );
    assert.ok(again.id);
    assert.notEqual(again.id, group.id);
    f.store.execute(command({ type: "run.cancel", runId: group.id }));
    f.store.execute(command({ type: "run.cancel", runId: again.id }));
    const files = Array.from({ length: 8 }, (_, index) => {
      const id = randomUUID();
      f.store.files.registerAttachment(
        { id, conversationId, name: `note-${index}.txt` },
        Buffer.from(`file ${index}`),
      );
      return id;
    });
    const packed = f.store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "files",
        attachmentIds: files,
      }),
    );
    assert.ok(packed.id);
    const packedId = packed.id;
    const extraId = randomUUID();
    f.store.files.registerAttachment(
      { id: extraId, conversationId, name: "extra.txt" },
      Buffer.from("extra"),
    );
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "message.send",
            conversationId,
            text: "too many",
            attachmentIds: [extraId],
          }),
        ),
      /8 个上限/,
    );
    const noted = f.store.execute(
      command({ type: "message.send", conversationId, text: "note" }),
    );
    assert.equal(noted.id, packedId);
    const packedJob = f.store.runs.claim();
    assert.equal(packedJob?.id, packedId);
    assert.equal(packedJob?.attachments.length, 8);
    assert.match(packedJob?.text ?? "", /files\n用户追加的指令：\nnote/);
    assert.ok(packedJob);
    f.store.runs.output.writeTool(packedJob, "tool-1", {
      kind: "command",
      command: "read example.txt",
      cwd: "/workspace",
      status: "failed",
      output: "",
      truncated: false,
      exitCode: 1,
      durationMs: 1,
    });
    f.store.runs.finish(packedJob.id, "failed", "tool failed");
    assert.throws(
      () => f.store.execute(command({ type: "run.retry", runId: packedId })),
      /副作用/,
    );
    const owner = f.store.views
      .snapshot({})
      .conversations.find((item) => item.id === conversationId)?.botId;
    assert.ok(owner);
    let occupied: { conversationId: string; runId: string } | undefined;
    for (let i = 0; i < 100; i++) {
      const extra = f.store.execute(
        command({ type: "conversation.create", botId: owner }),
      ).conversationId;
      assert.ok(extra);
      const queued = f.store.execute(
        command({
          type: "message.send",
          conversationId: extra,
          text: "queued",
        }),
      );
      assert.ok(queued.id);
      occupied = { conversationId: extra, runId: queued.id };
    }
    assert.ok(occupied);
    const joined = f.store.execute(
      command({
        type: "message.send",
        conversationId: occupied.conversationId,
        text: "still fits",
      }),
    );
    assert.equal(joined.id, occupied.runId);
    const overflow = f.store.execute(
      command({ type: "conversation.create", botId: owner }),
    ).conversationId;
    assert.ok(overflow);
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "message.send",
            conversationId: overflow,
            text: "new run",
          }),
        ),
      /队列已满/,
    );
    const version = new DatabaseSync(join(f.directory, "db.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        version.prepare("PRAGMA user_version").get()?.user_version,
        maxDatabaseVersion,
      );
    } finally {
      version.close();
    }
  } finally {
    f.close();
  }
});
