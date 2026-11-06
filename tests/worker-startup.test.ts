import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWorker } from "../src/worker/server.js";
import { callWorker, connectWorker, readWorker } from "../src/worker/client.js";
import { portForDirectory, type Endpoint } from "../src/platform/endpoint.js";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { resultSchema } from "../src/shared/core.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

async function workerDirectory(prefix: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    // Keep fixture listeners below Linux's default ephemeral range (32768+).
    // Otherwise unrelated outgoing connections can occupy the hashed port.
    const port = portForDirectory(directory);
    if (port >= 32768) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EADDRINUSE" || error.code === "EACCES")
      )
        continue;
      throw error;
    }
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    return directory;
  }
  throw new Error("No available worker fixture port below 32768");
}

async function stop(endpoint: Endpoint) {
  await callWorker(endpoint, "/command", {
    id: randomUUID(),
    command: { type: "worker.stop" },
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
    } catch {
      return;
    }
    assert.ok(Date.now() < deadline, "worker must release the listener");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await test("worker directory ownership excludes alternate ports and directory aliases, and releases after stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-worker-owner-"));
  const directory = join(root, "owned"),
    alias = join(root, "alias");
  const worker = await startWorker(directory, { port: 0 });
  try {
    await symlink(directory, alias, "junction");
    for (const path of [directory, alias])
      await assert.rejects(startWorker(path, { port: 0 }), {
        code: "EADDRINUSE",
      });
    const first = worker.stop(),
      second = worker.stop();
    assert.equal(first, second, "all stop callers must await the same drain");
    await first;
    const restarted = await startWorker(alias, { port: 0 });
    await restarted.stop();
  } finally {
    await worker.stop();
    // Remove only the link itself before removing this test's owned directory.
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

await test("bundled worker reports corrupt SQLite immediately, preserves it, and recovers after an explicit fixture repair", async () => {
  const directory = await workerDirectory("aster-worker-corrupt-");
  // Signed-out (guest) local data lives under accounts/guest, not the top-level directory.
  const accountDir = join(directory, "accounts", "guest");
  const path = join(accountDir, "aster.sqlite");
  const damaged = Buffer.from("not a sqlite database");
  let endpoint: Endpoint | undefined;
  try {
    await mkdir(accountDir, { recursive: true });
    await writeFile(path, damaged);
    await assert.rejects(
      connectWorker(directory, resolve("dist/worker/main.js")),
      /file is not a database/,
    );
    assert.deepEqual(await readFile(path), damaged);
    // Repair is confined to deliberately corrupt test data; startup never resets a user's DB.
    await rm(path);
    endpoint = await connectWorker(directory, resolve("dist/worker/main.js"));
    assert.notEqual(endpoint.pid, process.pid);
    assert.equal((await readWorker(directory)).pid, endpoint.pid);
  } finally {
    if (endpoint) await stop(endpoint);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

await test("concurrent bundled launchers connect one owner, detect a stale PID and restart after orderly shutdown", async () => {
  const directory = await workerDirectory("aster-worker-launch-");
  let endpoint: Endpoint | undefined;
  try {
    const attempts = await Promise.allSettled([
      connectWorker(directory, resolve("dist/worker/main.js")),
      connectWorker(directory, resolve("dist/worker/main.js")),
    ]);
    endpoint = attempts.find((result) => result.status === "fulfilled")?.value;
    for (const result of attempts) assert.equal(result.status, "fulfilled");
    assert.ok(endpoint);
    assert.ok(
      attempts.every(
        (result) =>
          result.status === "fulfilled" && result.value.pid === endpoint?.pid,
      ),
    );
    await writeFile(
      join(directory, "endpoint.json"),
      JSON.stringify({ ...endpoint, pid: endpoint.pid + 1 }),
    );
    await assert.rejects(readWorker(directory), /实际进程不匹配/);
    await writeFile(join(directory, "endpoint.json"), JSON.stringify(endpoint));
    const originalPid = endpoint.pid;
    await stop(endpoint);
    endpoint = undefined;
    endpoint = await connectWorker(directory, resolve("dist/worker/main.js"));
    assert.notEqual(endpoint.pid, originalPid);
  } finally {
    if (endpoint) await stop(endpoint);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

await test("an occupied TCP port fails without opening the database, and releasing it allows a normal start", async () => {
  const directory = await workerDirectory("aster-worker-port-");
  const occupant = createServer((socket) => socket.destroy());
  let endpoint: Endpoint | undefined;
  try {
    await mkdir(directory, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      occupant.once("error", reject);
      occupant.listen(portForDirectory(directory), "127.0.0.1", resolve);
    });
    await assert.rejects(
      connectWorker(directory, resolve("dist/worker/main.js")),
      /EADDRINUSE/,
    );
    await assert.rejects(readFile(join(directory, "aster.sqlite")), {
      code: "ENOENT",
    });
    await new Promise<void>((resolve, reject) =>
      occupant.close((error) => (error ? reject(error) : resolve())),
    );
    endpoint = await connectWorker(directory, resolve("dist/worker/main.js"));
  } finally {
    if (endpoint) await stop(endpoint);
    if (occupant.listening)
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

await test("abrupt death releases the OS lease and recovery preserves committed user data", async () => {
  const directory = await workerDirectory("aster-worker-crash-");
  let endpoint: Endpoint | undefined;
  try {
    endpoint = await connectWorker(directory, resolve("dist/worker/main.js"));
    const created = resultSchema.parse(
      await callWorker(endpoint, "/command", {
        id: randomUUID(),
        command: {
          type: "bot.create",
          name: "Crash recovery",
          description: "Preserve committed state",
        },
      }),
    );
    assert.ok(created.id);
    const ownedPid = endpoint.pid;
    process.kill(ownedPid, "SIGKILL");
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        process.kill(ownedPid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          break;
        throw error;
      }
      assert.ok(Date.now() < deadline, "owned process must actually exit");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    endpoint = undefined;
    endpoint = await connectWorker(directory, resolve("dist/worker/main.js"));
    const state = await workerSnapshot(endpoint);
    assert.equal(
      state.bots.find((bot) => bot.id === created.id)?.description,
      "Preserve committed state",
    );
  } finally {
    if (endpoint) await stop(endpoint);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
