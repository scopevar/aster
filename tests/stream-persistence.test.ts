import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { sameCursor } from "../src/shared/worker-events.js";
import { Store } from "../src/storage/store.js";

function command(value: Command) {
  return envelopeSchema.parse({
    id: randomUUID(),
    command: value,
  });
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aster-stream-"));
  const path = join(directory, "db.sqlite");
  const store = new Store(path);
  const conversationId = store.execute(
    command({ type: "bot.create", name: "Test", description: "" }),
  ).conversationId;
  assert.ok(conversationId);
  store.execute(command({ type: "message.send", conversationId, text: "go" }));
  const job = store.runs.claim();
  assert.ok(job);
  return {
    directory,
    path,
    store,
    job,
    conversationId,
    messages() {
      return store.views
        .snapshot({ conversationId })
        .messages.filter((message) => message.role === "assistant");
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const runningTool = {
  kind: "command",
  command: "ls",
  cwd: "/tmp",
  status: "running",
  output: "",
  truncated: false,
  exitCode: null,
  durationMs: null,
} as const;

await test("批量写入一次事务只记一次 revision，结果与逐条写入完全一致", () => {
  const batched = fixture();
  const single = fixture();
  try {
    const tokens = ["第一段", "。", "第二段", "。", "收尾"];
    const before = batched.store.cursor();
    batched.store.runs.output.writeStream(
      batched.job,
      tokens.map((text) => ({
        kind: "text" as const,
        itemId: "answer",
        text,
        replace: false,
      })),
    );
    const after = batched.store.cursor();
    for (const text of tokens)
      single.store.runs.output.writeText(single.job, "answer", text, false);
    assert.equal(after.revision - before.revision, 1, "一次事务一次 revision");
    assert.equal(after.epoch, before.epoch);
    assert.equal(batched.messages()[0]?.text, tokens.join(""));
    assert.equal(
      batched.messages()[0]?.text,
      single.messages()[0]?.text,
      "批量与逐条的最终文本一致",
    );
    assert.equal(
      single.store.cursor().revision - before.revision,
      tokens.length,
      "逐条写入每个 token 一次 revision",
    );
  } finally {
    batched.close();
    single.close();
  }
});

await test("同一事务内文本与工具输出按首次出现顺序落库，顺序与逐条写入一致", () => {
  const f = fixture();
  try {
    f.store.runs.output.writeTool(f.job, "tool-1", runningTool);
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "before", text: "先说明", replace: false },
      { kind: "tool-output", itemId: "tool-1", delta: "输出\n" },
      { kind: "text", itemId: "after", text: "后总结", replace: false },
    ]);
    const messages = f.messages();
    assert.deepEqual(
      messages.map((message) => message.text),
      ["执行命令", "先说明", "后总结"],
    );
    assert.equal(messages[0]?.tool?.output, "输出\n");
  } finally {
    f.close();
  }
});

await test("规范文本覆盖已落库的增量，追加不再整段读改写", () => {
  const f = fixture();
  try {
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "草稿", replace: false },
    ]);
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "补充", replace: false },
    ]);
    assert.equal(f.messages()[0]?.text, "草稿补充");
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "最终文本", replace: true },
    ]);
    assert.equal(f.messages()[0]?.text, "最终文本");
  } finally {
    f.close();
  }
});

await test("运行终止后迟到的批量写入被丢弃", () => {
  const f = fixture();
  try {
    f.store.runs.finish(f.job.id, "cancelled", null);
    const before = f.store.cursor();
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "迟到内容", replace: false },
    ]);
    assert.deepEqual(f.messages(), []);
    assert.ok(
      sameCursor(f.store.cursor(), before),
      "无写入不应产生新 revision",
    );
  } finally {
    f.close();
  }
});

await test("工具输出缺少对应调用时，同批已处理的文本仍然落库后再报错", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.runs.output.writeStream(f.job, [
          { kind: "text", itemId: "answer", text: "已产出", replace: false },
          { kind: "tool-output", itemId: "missing", delta: "孤儿输出" },
          { kind: "text", itemId: "later", text: "不应出现", replace: false },
        ]),
      /工具输出缺少对应调用/,
    );
    assert.deepEqual(
      f.messages().map((message) => message.text),
      ["已产出"],
    );
  } finally {
    f.close();
  }
});

await test("工具输出上限与截断标记在批量写入下不变", () => {
  const f = fixture();
  try {
    f.store.runs.output.writeTool(f.job, "tool-1", runningTool);
    f.store.runs.output.writeStream(f.job, [
      { kind: "tool-output", itemId: "tool-1", delta: "x".repeat(70000) },
      { kind: "tool-output", itemId: "tool-1", delta: "溢出后忽略" },
    ]);
    const tool = f.messages()[0]?.tool;
    assert.equal(tool?.output.length, 65536);
    assert.equal(tool?.truncated, true);
  } finally {
    f.close();
  }
});

await test("重开恢复保留已提交流式文本，将中断运行标记为 unknown 且不自动重发", () => {
  const f = fixture();
  try {
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "已落库部分", replace: false },
    ]);
    f.store.close();
    const reopened = new Store(f.path);
    try {
      reopened.recover();
      const view = reopened.views.snapshot({
        conversationId: f.conversationId,
      });
      assert.equal(
        view.messages.find((message) => message.role === "assistant")?.text,
        "已落库部分",
        "已提交的窗口完整可读",
      );
      assert.equal(view.runs[0]?.status, "unknown");
      assert.equal(reopened.runs.claim(), undefined, "不会自动重新发送");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

await test("写库却漏记 revision 的路径由事务兜底，提交后通知订阅者", () => {
  const f = fixture();
  try {
    f.store.runs.finish(f.job.id, "cancelled", null);
    const botId = f.store.views.snapshot({}).bots[0]?.id;
    assert.ok(botId);
    const deletion = f.store.execute(
      command({
        type: "entity.delete",
        kind: "bot",
        targetId: botId,
        expectedName: "Test",
      }),
    ).id;
    assert.ok(deletion);
    f.store.deletionOperations.deletionStart(deletion);
    const seen: number[] = [];
    const stop = f.store.subscribe(() => {
      seen.push(f.store.cursor().revision);
    });
    const before = f.store.cursor().revision;
    // deletionPlan 会写入 planJson 却没有调用 changed()，靠事务兜底补记。
    f.store.deletionOperations.deletionPlan(deletion);
    const afterPlan = f.store.cursor().revision;
    assert.ok(afterPlan > before, "写入了库就必须让界面看到变化");
    assert.deepEqual(seen, [afterPlan]);
    stop();
    f.store.deletionOperations.deletionFail(deletion, "停在这里");
    assert.deepEqual(seen, [afterPlan], "注销后不再收到通知");
  } finally {
    f.close();
  }
});

await test("只读事务不产生 revision，也不通知订阅者", () => {
  const f = fixture();
  try {
    let notified = 0;
    const stop = f.store.subscribe(() => {
      notified++;
    });
    const before = f.store.cursor();
    assert.deepEqual(f.store.templateOperations.localTemplates(), {
      drafts: [],
    });
    assert.ok(sameCursor(f.store.cursor(), before));
    assert.equal(notified, 0);
    stop();
  } finally {
    f.close();
  }
});

await test("不同数据库的 epoch 不同，revision 回退不会被误判为未变化", () => {
  const a = fixture();
  const b = fixture();
  try {
    assert.notEqual(a.store.cursor().epoch, b.store.cursor().epoch);
    assert.ok(!sameCursor(a.store.cursor(), b.store.cursor()));
  } finally {
    a.close();
    b.close();
  }
});

await test("游标一致时不重算快照，变化后立刻返回完整快照", () => {
  const f = fixture();
  try {
    const first = f.store.snapshotSince({ conversationId: f.conversationId });
    assert.ok(first);
    const cursor = { epoch: first.epoch, revision: first.revision };
    assert.equal(
      f.store.snapshotSince({
        conversationId: f.conversationId,
        since: cursor,
      }),
      undefined,
      "未变化不应重算",
    );
    f.store.runs.output.writeStream(f.job, [
      { kind: "text", itemId: "answer", text: "新内容", replace: false },
    ]);
    const second = f.store.snapshotSince({
      conversationId: f.conversationId,
      since: cursor,
    });
    assert.ok(second);
    assert.equal(
      second.messages.find((message) => message.role === "assistant")?.text,
      "新内容",
    );
  } finally {
    f.close();
  }
});

await test("跨库游标不会被误判为未变化", () => {
  const a = fixture();
  const b = fixture();
  try {
    const view = a.store.snapshotSince({});
    assert.ok(view);
    assert.ok(
      b.store.snapshotSince({
        since: { epoch: view.epoch, revision: view.revision },
      }),
      "epoch 不同必须返回完整快照",
    );
  } finally {
    a.close();
    b.close();
  }
});

await test("流式落库事务数随批量窗口下降，长文本不再整段重写", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const tokens = Array.from({ length: 600 }, (_, index) => `t${index}`);
      const before = f.store.cursor().revision;
      // 每 100 个 token 一个窗口，模拟 StreamBuffer 的合并结果。
      for (let index = 0; index < tokens.length; index += 100)
        f.store.runs.output.writeStream(f.job, [
          {
            kind: "text",
            itemId: "answer",
            text: tokens.slice(index, index + 100).join(""),
            replace: false,
          },
        ]);
      assert.equal(
        f.store.cursor().revision - before,
        6,
        "600 个 token 只用 6 个事务",
      );
      assert.equal(f.messages()[0]?.text, tokens.join(""));
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});
