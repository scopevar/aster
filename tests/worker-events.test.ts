import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import { WorkerConnection } from "../src/desktop/worker/worker-connection.js";
import { EventParser, WorkerFeed } from "../src/desktop/worker/worker-feed.js";
import { envelopeSchema } from "../src/shared/commands.js";
import { resultSchema } from "../src/shared/core.js";
import { nudgeWorker } from "./helpers/worker-snapshot.js";
import type { WorkerSignal } from "../src/shared/worker-events.js";

const fast = { staleAfterMs: 2000, retryMinMs: 20, retryMaxMs: 100 };

function waitFor(
  feed: WorkerFeed,
  accept: (signal: WorkerSignal) => boolean,
  timeoutMs = 5000,
) {
  return new Promise<WorkerSignal>((resolve, reject) => {
    if (accept(feed.status())) return resolve(feed.status());
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(`等待推送超时，当前状态 ${JSON.stringify(feed.status())}`),
      );
    }, timeoutMs);
    const unsubscribe = feed.subscribe((signal) => {
      if (!accept(signal)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(signal);
    });
  });
}

function live(signal: WorkerSignal) {
  return signal.state === "live" ? signal.cursor : undefined;
}

await test("SSE 解析跨 chunk 拼接事件，忽略心跳注释并拒绝超大块", () => {
  const parser = new EventParser();
  assert.deepEqual(parser.push(": ping\n\n"), []);
  assert.deepEqual(parser.push('data: {"a"'), []);
  assert.deepEqual(parser.push(":1}\n\ndata: 2\n\ndata: 3"), ['{"a":1}', "2"]);
  assert.deepEqual(parser.push("\n\n"), ["3"]);
  assert.throws(() => parser.push("x".repeat(64 * 1024 + 1)));
});

await test("推送随提交更新游标；worker 重启后以新 epoch 恢复，stop 之后不再通知", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-events-"));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  // 共用一个连接：重启后端口与 token 都变了，必须靠失败作废缓存才能重连成功。
  const connection = new WorkerConnection(directory);
  const feed = new WorkerFeed(
    (signal) => connection.stream("/events", signal),
    fast,
  );
  try {
    worker = await startWorker(directory, { port: 0 });
    feed.start();
    const first = live(await waitFor(feed, (s) => s.state === "live"));
    assert.ok(first);
    await callWorker(
      worker.endpoint,
      "/command",
      envelopeSchema.parse({
        id: randomUUID(),
        command: { type: "bot.create", name: "推送", description: "" },
      }),
    );
    const next = live(
      await waitFor(feed, (s) => (live(s)?.revision ?? 0) > first.revision),
    );
    assert.equal(next?.epoch, first.epoch);

    await worker.stop();
    worker = undefined;
    await waitFor(feed, (s) => s.state === "offline");

    worker = await startWorker(directory, { port: 0 });
    const restarted = live(await waitFor(feed, (s) => s.state === "live"));
    assert.ok(restarted);
    assert.notEqual(restarted.epoch, first.epoch);

    let late = 0;
    feed.subscribe(() => {
      late += 1;
    });
    await feed.stop();
    await worker.stop();
    worker = undefined;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(late, 0);
  } finally {
    await feed.stop();
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("心跳停止的僵死连接被看门狗中止并重连，非游标载荷视为协议错误", async () => {
  let connections = 0;
  let thirdConnection = () => {};
  // A third connection proves the invalid second payload was rejected and retried.
  const retried = new Promise<void>((resolve) => {
    thirdConnection = resolve;
  });
  const cursor = { epoch: randomUUID(), revision: 1 };
  const server = createServer((_request, response) => {
    connections += 1;
    if (connections === 3) thirdConnection();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    // 第一条连接只发一次游标后沉默；第二条发送带用户数据的非法载荷。
    if (connections === 1)
      response.write(`data: ${JSON.stringify(cursor)}\n\n`);
    else
      response.write(`data: ${JSON.stringify({ ...cursor, text: "x" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const feed = new WorkerFeed(
    async (signal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        signal,
      });
      assert.ok(response.body);
      return response.body;
    },
    { staleAfterMs: 150, retryMinMs: 10, retryMaxMs: 20 },
  );
  try {
    feed.start();
    assert.deepEqual(
      live(await waitFor(feed, (s) => s.state === "live")),
      cursor,
    );
    await waitFor(feed, (s) => s.state === "offline");
    let relived = 0;
    feed.subscribe((signal) => {
      if (signal.state === "live") relived += 1;
    });
    await retried;
    assert.equal(relived, 0);
    assert.equal(feed.status().state, "offline");
  } finally {
    await feed.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

await test("未带正确 token 的事件订阅被拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-events-auth-"));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker(directory, { port: 0 });
    const response = await fetch(
      `http://127.0.0.1:${worker.endpoint.port}/events`,
      { headers: { Authorization: `Bearer ${"0".repeat(64)}` } },
    );
    assert.equal(response.status, 401);
    await response.body?.cancel();
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("内容不变的 draft.save 也会推送变化，供绕过 worker 改库的用例触发界面刷新", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-events-nudge-"));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const connection = new WorkerConnection(directory);
  const feed = new WorkerFeed(
    (signal) => connection.stream("/events", signal),
    fast,
  );
  try {
    worker = await startWorker(directory, { port: 0 });
    const { conversationId } = resultSchema.parse(
      await callWorker(
        worker.endpoint,
        "/command",
        envelopeSchema.parse({
          id: randomUUID(),
          command: { type: "bot.create", name: "刷新", description: "" },
        }),
      ),
    );
    assert.ok(conversationId);
    feed.start();
    const before = live(await waitFor(feed, (s) => s.state === "live"));
    assert.ok(before);
    await nudgeWorker(worker.endpoint, conversationId);
    await waitFor(feed, (s) => (live(s)?.revision ?? 0) > before.revision);
  } finally {
    await feed.stop();
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
