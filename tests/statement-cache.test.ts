import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { CachedDatabase } from "../src/storage/statement-cache.js";
import { Store } from "../src/storage/store.js";

await test("同一 SQL 复用已编译语句，超出上限时淘汰最久未用的", () => {
  const db = new CachedDatabase(":memory:");
  try {
    const first = db.prepare("SELECT 0 AS x");
    const second = db.prepare("SELECT 1 AS x");
    for (let i = 2; i < 512; i++) db.prepare(`SELECT ${i} AS x`);
    assert.equal(db.prepare("SELECT 0 AS x"), first);
    db.prepare("SELECT 512 AS x");
    assert.equal(db.prepare("SELECT 0 AS x"), first, "最近访问的语句应保留");
    assert.notEqual(
      db.prepare("SELECT 1 AS x"),
      second,
      "最久未使用的语句应淘汰",
    );
    assert.deepEqual({ ...db.prepare("SELECT 1 AS x").get() }, { x: 1 });
  } finally {
    db.close();
  }
});

await test("表结构变化后缓存语句仍按新结构执行", () => {
  const db = new CachedDatabase(":memory:");
  try {
    db.exec("CREATE TABLE t(a)");
    db.prepare("INSERT INTO t VALUES(?)").run(1);
    const rows = () =>
      db
        .prepare("SELECT * FROM t")
        .all()
        .map((row) => ({ ...row }));
    assert.deepEqual(rows(), [{ a: 1 }]);
    db.exec("DROP TABLE t; CREATE TABLE t(a, b); INSERT INTO t VALUES(2, 3)");
    assert.deepEqual(rows(), [{ a: 2, b: 3 }]);
  } finally {
    db.close();
  }
});

await test("iterate 循环内重用同一 SQL 会显式失败，而不是静默返回错误数据", () => {
  const db = new CachedDatabase(":memory:");
  try {
    db.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1),(2)");
    const sql = "SELECT x FROM t ORDER BY x";
    assert.throws(() => {
      const rows = db.prepare(sql).iterate();
      rows.next();
      db.prepare(sql).all();
      rows.next();
    }, /invalidated/);
  } finally {
    db.close();
  }
});

await test("提前退出与完整遍历都释放语句，命名绑定保持可用", () => {
  const db = new CachedDatabase(":memory:");
  try {
    db.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1),(2)");
    const sql = "SELECT x FROM t WHERE x>=:min ORDER BY x";
    for (const row of db.prepare(sql).iterate({ ":min": 1 })) {
      assert.equal(row.x, 1);
      break;
    }
    assert.deepEqual(
      [...db.prepare(sql).iterate({ ":min": 2 })].map((row) => ({ ...row })),
      [{ x: 2 }],
    );
    assert.equal(db.prepare(sql).get({ ":min": 1 })?.x, 1);
  } finally {
    db.close();
  }
});

await test("Store 缓存快照重复读取与重开后保持一致", () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-cache-"));
  const command = (value: Command) =>
    envelopeSchema.parse({
      id: randomUUID(),
      command: value,
    });
  const path = join(directory, "db.sqlite");
  const store = new Store(path);
  let closed = false;
  try {
    const conversationId = store.execute(
      command({ type: "bot.create", name: "缓存", description: "" }),
    ).conversationId;
    assert.ok(conversationId);
    store.execute(
      command({ type: "message.send", conversationId, text: "hi" }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    store.runs.output.writeText(job, "a", "reply", true);
    store.runs.settlePrivateTurn(job);
    store.runs.finish(job.id, "completed", null);
    const warm = store.views.snapshot({ conversationId });
    assert.deepEqual(
      warm.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "reply" },
      ],
    );
    assert.equal(warm.runs[0]?.status, "completed");
    assert.deepEqual(store.views.snapshot({ conversationId }), warm);
    store.close();
    closed = true;
    const reopened = new Store(path);
    try {
      const cold = reopened.views.snapshot({ conversationId });
      assert.deepEqual({ ...cold, epoch: null }, { ...warm, epoch: null });
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
