import type { StreamEntry } from "../src/storage/runs/stream-entry.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamBuffer } from "../src/chat/stream-buffer.js";

function collect() {
  const flushes: StreamEntry[][] = [];
  const buffer = new StreamBuffer((entries) => {
    flushes.push(entries.map((entry) => ({ ...entry })));
  });
  return { flushes, buffer };
}

await test("逐 token 增量合并为一次落库，保留首次出现顺序", () => {
  const { flushes, buffer } = collect();
  for (const token of ["你", "好", "世", "界"]) buffer.text("a", token, false);
  buffer.text("b", "第二条", false);
  buffer.text("a", "！", false);
  assert.equal(flushes.length, 0, "阈值未到不应落库");
  buffer.flush();
  assert.deepEqual(flushes, [
    [
      { kind: "text", itemId: "a", text: "你好世界！", replace: false },
      { kind: "text", itemId: "b", text: "第二条", replace: false },
    ],
  ]);
  buffer.close();
  assert.equal(flushes.length, 1, "空缓冲不产生多余事务");
});

await test("达到字符阈值立即落库，不等待定时器", () => {
  const { flushes, buffer } = collect();
  buffer.text("a", "x".repeat(4095), false);
  assert.equal(flushes.length, 0);
  buffer.text("a", "yz", false);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0]?.[0]?.kind, "text");
  assert.equal(
    flushes[0]?.[0]?.kind === "text" && flushes[0][0].text.length,
    4097,
  );
});

await test("定时器到期后自动落库", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { flushes, buffer } = collect();
  buffer.text("a", "延迟", false);
  assert.equal(flushes.length, 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(flushes, [
    [{ kind: "text", itemId: "a", text: "延迟", replace: false }],
  ]);
  buffer.close();
});

await test("规范文本丢弃该 item 的未落库增量并立即落库", () => {
  const { flushes, buffer } = collect();
  buffer.text("a", "半", false);
  buffer.text("b", "另一条", false);
  buffer.text("a", "完整文本", true);
  assert.deepEqual(flushes, [
    [
      { kind: "text", itemId: "a", text: "完整文本", replace: true },
      { kind: "text", itemId: "b", text: "另一条", replace: false },
    ],
  ]);
});

await test("工具输出与文本分开合并，同一事务内按首次出现顺序写入", () => {
  const { flushes, buffer } = collect();
  buffer.toolOutput("t1", "line1\n");
  buffer.text("m1", "说明", false);
  buffer.toolOutput("t1", "line2\n");
  buffer.flush();
  assert.deepEqual(flushes, [
    [
      { kind: "tool-output", itemId: "t1", delta: "line1\nline2\n" },
      { kind: "text", itemId: "m1", text: "说明", replace: false },
    ],
  ]);
});

await test("关闭后迟到的事件直接落库，不再留在缓冲里", () => {
  const { flushes, buffer } = collect();
  buffer.text("a", "第一段", false);
  buffer.close();
  buffer.text("a", "迟到", false);
  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[1], [
    { kind: "text", itemId: "a", text: "迟到", replace: false },
  ]);
});

await test("落库失败在下一次事件抛出，且 flush 的失败直接抛给调用方", () => {
  let fail = true;
  const buffer = new StreamBuffer(() => {
    if (fail) throw new Error("落库失败");
  });
  assert.throws(() => {
    buffer.text("a", "x".repeat(5000), false);
  }, /落库失败/);
  fail = false;
  buffer.text("a", "继续", false);
  buffer.close();
});

await test("定时器里的失败延迟到下一次事件抛出，而不是变成未捕获异常", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fail = true;
  const buffer = new StreamBuffer(() => {
    if (fail) throw new Error("定时落库失败");
  });
  buffer.text("a", "内容", false);
  t.mock.timers.tick(1000);
  fail = false;
  assert.throws(() => {
    buffer.text("a", "再来", false);
  }, /定时落库失败/);
  buffer.close();
});

await test("closeQuietly 尝试排空、吞掉二次失败并关闭缓冲", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flushes: StreamEntry[][] = [];
  let fail = true;
  const buffer = new StreamBuffer((entries) => {
    flushes.push(entries.map((entry) => ({ ...entry })));
    if (fail) throw new Error("落库失败");
  });
  buffer.text("a", "内容", false);
  assert.doesNotThrow(() => buffer.closeQuietly());
  assert.deepEqual(flushes, [
    [{ kind: "text", itemId: "a", text: "内容", replace: false }],
  ]);
  fail = false;
  buffer.text("a", "迟到", false);
  assert.deepEqual(flushes[1], [
    { kind: "text", itemId: "a", text: "迟到", replace: false },
  ]);
  t.mock.timers.tick(1000);
  buffer.closeQuietly();
  assert.equal(flushes.length, 2, "关闭后不再定时落库或重试失败内容");
});
