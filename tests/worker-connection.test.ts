import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WorkerConnection } from "../src/desktop/worker/worker-connection.js";
import { AppError } from "../src/shared/core.js";

type Stub = {
  port: number;
  requests: string[];
  token: string;
  rotate: (next: string) => void;
  close: () => Promise<void>;
};

async function stubWorker(handler?: (path: string) => unknown): Promise<Stub> {
  const requests: string[] = [];
  const token = randomBytes(32).toString("hex");
  let expected = token;
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    if (request.headers.authorization !== `Bearer ${expected}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "unauthorized", message: "拒绝" } }),
      );
      return;
    }
    const body = path.endsWith("/health")
      ? { pid: process.pid }
      : (handler?.(path) ?? { ok: true });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    requests,
    token,
    rotate: (next: string) => {
      expected = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function publish(directory: string, stub: Stub) {
  await writeFile(
    join(directory, "endpoint.json"),
    JSON.stringify({
      port: stub.port,
      token: stub.token,
      pid: process.pid,
    }),
  );
}

await test("endpoint 只解析一次，后续请求不再重复健康检查", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-conn-"));
  const stub = await stubWorker();
  try {
    await publish(directory, stub);
    const worker = new WorkerConnection(directory);
    await worker.call("/snapshot", {});
    await worker.call("/snapshot", {});
    await worker.call("/snapshot", {});
    assert.deepEqual(
      stub.requests.filter((path) => path.endsWith("/health")).length,
      1,
      "缓存命中后不应再做健康检查",
    );
    assert.equal(
      stub.requests.filter((path) => path.endsWith("/snapshot")).length,
      3,
    );
  } finally {
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("后台换端口后连接被拒，自动重读 endpoint 并重试一次", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-conn-restart-"));
  const first = await stubWorker();
  let second: Stub | undefined;
  try {
    await publish(directory, first);
    const worker = new WorkerConnection(directory);
    assert.deepEqual(await worker.call("/snapshot", {}), { ok: true });
    await first.close();
    second = await stubWorker(() => ({ ok: "restarted" }));
    await publish(directory, second);
    assert.deepEqual(await worker.call("/snapshot", {}), {
      ok: "restarted",
    });
  } finally {
    await first.close().catch(() => {});
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("鉴权失败不重发请求，只作废缓存", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-conn-auth-"));
  const stub = await stubWorker();
  try {
    await publish(directory, stub);
    const worker = new WorkerConnection(directory);
    await worker.call("/snapshot", {});
    // token 轮换后旧缓存会被后台拒绝。
    const next = randomBytes(32).toString("hex");
    stub.rotate(next);
    await publish(directory, { ...stub, token: next });
    const rotated = stub.requests.length;
    await assert.rejects(
      () => worker.call("/snapshot", {}),
      (error: unknown) =>
        error instanceof AppError && error.code === "unauthorized",
    );
    assert.equal(
      stub.requests.length - rotated,
      1,
      "401 不得重发，避免命令被重复提交",
    );
    // 作废后的下一次调用重新解析 endpoint，拿到新 token 后恢复正常。
    assert.deepEqual(await worker.call("/snapshot", {}), { ok: true });
    assert.ok(
      stub.requests.filter((path) => path.endsWith("/health")).length >= 2,
    );
  } finally {
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("已处理的请求即使连接重置且 endpoint 变更，也不能自动重发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-conn-reset-"));
  const next = await stubWorker();
  let applied = 0;
  const first = createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ pid: process.pid }));
      return;
    }
    request.resume();
    request.once("end", () => {
      applied++;
      void publish(directory, next).then(
        () => request.socket.resetAndDestroy(),
        (error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
      );
    });
  });
  try {
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const address = first.address();
    assert.ok(address && typeof address !== "string");
    await publish(directory, { ...next, port: address.port });
    await assert.rejects(new WorkerConnection(directory).call("/command", {}));
    assert.equal(applied, 1);
    assert.equal(next.requests.includes("/command"), false);
  } finally {
    first.closeAllConnections();
    await new Promise<void>((resolve) => first.close(() => resolve()));
    await next.close();
    await rm(directory, { recursive: true, force: true });
  }
});
