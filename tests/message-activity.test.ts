import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  envelopeSchema,
  type Command,
  type Envelope,
} from "../src/shared/commands.js";
import { type Message } from "../src/shared/chat/messages.js";
import { storedDesktopEnvelopeSchema } from "../src/shared/desktop/desktop-commands.js";
import { Store } from "../src/storage/store.js";
import { messageActivity } from "../src/ui/features/messages/message-activity.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aster-activity-"));
  const store = new Store(join(directory, "db.sqlite"));
  const request = (command: Command): Envelope => ({
    id: randomUUID(),
    command,
  });
  const bot = store.execute(
    request({ type: "bot.create", name: "测试", description: "" }),
  );
  assert.ok(bot.id && bot.conversationId);
  return {
    store,
    request,
    botId: bot.id,
    conversationId: bot.conversationId,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

await test("用户气泡复用信封 ID，追加与重放保持单条消息；旧缓存迁移保留原 ID", () => {
  const f = fixture();
  try {
    const first = f.request({
      type: "message.send",
      conversationId: f.conversationId,
      text: "第一条",
    });
    const run = f.store.execute(first);
    assert.deepEqual(f.store.execute(first), run);
    const job = f.store.runs.claim();
    assert.ok(job);
    const second = f.request({
      type: "message.send",
      conversationId: f.conversationId,
      text: "追加",
    });
    assert.equal(f.store.execute(second).id, run.id);
    f.store.execute(second);
    assert.deepEqual(
      f.store.views
        .snapshot({ conversationId: f.conversationId })
        .messages.map((m) => m.id),
      [first.id, second.id],
    );
    for (const version of [19, 20, 21]) {
      const migrated = storedDesktopEnvelopeSchema.parse({
        ...second,
        version,
      });
      assert.equal(migrated.id, second.id);
      assert.deepEqual(f.store.execute(envelopeSchema.parse(migrated)), run);
    }
  } finally {
    f.close();
  }
});

await test("工具卡片与空文字不隐藏 loading，首段文字隐藏；追发移动表情，停止与终态清理", () => {
  const f = fixture();
  try {
    f.store.execute(
      f.request({
        type: "message.send",
        conversationId: f.conversationId,
        text: "开始",
      }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    const activity = () => {
      const s = f.store.views.snapshot({ conversationId: f.conversationId });
      return messageActivity(s.messages, s.runs);
    };
    assert.equal(activity()?.loading, true);
    f.store.runs.output.writeTool(job, "tool", {
      kind: "command",
      command: "echo ok",
      cwd: "/tmp",
      status: "completed",
      output: "ok",
      truncated: false,
      exitCode: 0,
      durationMs: 1,
    });
    assert.equal(activity()?.loading, true);
    f.store.runs.output.writeText(job, "2:private", "  ", false);
    assert.equal(activity()?.loading, true);
    f.store.runs.output.writeText(job, "2:private", "回复", false);
    assert.equal(activity()?.loading, false);
    const appended = f.request({
      type: "message.send",
      conversationId: f.conversationId,
      text: "追发",
    });
    f.store.execute(appended);
    assert.equal(activity()?.messageId, appended.id);
    assert.equal(activity()?.loading, false);
    const snapshot = f.store.views.snapshot({
      conversationId: f.conversationId,
    });
    assert.equal(
      snapshot.messages.at(-2)?.groupOrdinal,
      null,
      "私聊 item ID 的数字前缀不能误判为群聊轮次",
    );
    for (const status of [
      "completed",
      "failed",
      "unknown",
      "cancelled",
      "queued",
    ] as const)
      assert.equal(
        messageActivity(
          snapshot.messages,
          snapshot.runs.map((run) => ({ ...run, status })),
        ),
        null,
      );
    const stopping = messageActivity(
      snapshot.messages,
      snapshot.runs.map((run) => ({ ...run, status: "cancelling" })),
    );
    assert.equal(stopping?.loading, false);
    assert.equal(stopping?.messageId, appended.id);
    assert.equal(stopping?.stopping, true);
  } finally {
    f.close();
  }
});

await test("群聊同一个 Bot 的第二轮重新显示 loading，快照和历史都携带准确轮次", () => {
  const f = fixture();
  try {
    const request = f.request({
      type: "group.start",
      memberIds: [f.botId],
      text: "两轮",
    });
    const result = f.store.execute(request);
    assert.ok(result.conversationId);
    assert.equal(
      f.store.views.snapshot({ conversationId: result.conversationId })
        .messages[0]?.id,
      request.id,
    );
    const parent = f.store.runs.claim();
    assert.ok(parent);
    const first = f.store.runs.nextGroupTurn(parent);
    assert.ok(first);
    f.store.runs.output.writeText(first, "0:reply", "第一轮", true);
    f.store.runs.finishGroupTurn(first, "completed", null);
    const second = f.store.runs.nextGroupTurn(parent);
    assert.ok(second);
    let view = f.store.views.snapshot({
      conversationId: result.conversationId,
    });
    assert.equal(messageActivity(view.messages, view.runs)?.loading, true);
    f.store.runs.output.writeText(second, "1:reply", "第二轮", false);
    view = f.store.views.snapshot({ conversationId: result.conversationId });
    assert.equal(messageActivity(view.messages, view.runs)?.loading, false);
    assert.deepEqual(
      view.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.groupOrdinal),
      [0, 1],
    );
    const user: Message | undefined = view.messages[0];
    assert.ok(user);
    const history = f.store.views.messageHistory({
      version: 1,
      direction: "around",
      conversationId: result.conversationId,
      messageId: user.id,
    });
    assert.deepEqual(
      history.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.groupOrdinal),
      [0, 1],
    );
    f.store.runs.finishGroupTurn(second, "skipped", null);
    assert.equal(
      messageActivity(
        view.messages,
        f.store.views.snapshot({ conversationId: result.conversationId }).runs,
      )?.loading,
      false,
    );
  } finally {
    f.close();
  }
});
