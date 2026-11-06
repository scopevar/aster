import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWorker } from "../src/worker/client.js";
import { AppError } from "../src/shared/core.js";

await test("an unversioned connection still requires authenticated live PID ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-identity-"));
  const token = "a".repeat(64);
  const server = createServer((request, response) => {
    if (
      request.url !== "/health" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ pid: process.pid }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = { port: address.port, token, pid: process.pid + 1 };
    const file = join(directory, "endpoint.json");
    await writeFile(file, JSON.stringify(endpoint));
    await assert.rejects(
      readWorker(directory),
      (error) =>
        error instanceof AppError &&
        error.code === "unavailable" &&
        error.message.includes("实际进程不匹配"),
    );
    endpoint.pid = process.pid;
    await writeFile(file, JSON.stringify(endpoint));
    assert.deepEqual(await readWorker(directory), endpoint);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
