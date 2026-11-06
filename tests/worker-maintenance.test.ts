import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ownDirectory } from "../src/platform/directory-lease.js";
import {
  inspectWorker,
  stopWorker,
} from "../src/desktop/worker/worker-maintenance.js";

await test("doctor finds an authenticated legacy worker and restart uses its protocol then waits for both owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-maintenance-"));
  const worker = await ownDirectory(directory, "worker");
  const supervisor = await ownDirectory(directory, "supervisor");
  const token = "a".repeat(64),
    version = 20;
  let stops = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === `/v${version}/health`) {
      response.end(JSON.stringify({ version, pid: process.pid }));
      return;
    }
    assert.equal(request.url, `/v${version}/command`);
    assert.equal(request.method, "POST");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (text: string) => {
      body += text;
    });
    request.on("end", () => {
      const envelope = JSON.parse(body) as {
        version: number;
        command: { type: string };
      };
      assert.equal(envelope.version, version);
      assert.equal(envelope.command.type, "worker.stop");
      stops++;
      response.end("{}");
      release();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = { version, pid: process.pid, port: address.port, token };
    await writeFile(join(directory, "endpoint.json"), JSON.stringify(endpoint));
    const inspection = await inspectWorker(directory);
    assert.equal(inspection.state, "running", "old protocols are also stopped");
    // Exercise the bundled doctor entry against a real authenticated old worker.
    // The protocol must come from current sources, not an old dist bundle.
    await mkdir(join(directory, "node_modules", "electron"), {
      recursive: true,
    });
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, "node_modules", "electron", "index.js"),
      "throw new Error('Electron entry must not be evaluated');",
    );
    const electronDirectory = join(directory, "node_modules", "electron");
    await mkdir(join(electronDirectory, "dist"));
    await writeFile(join(electronDirectory, "path.txt"), "electron");
    const executable = join(electronDirectory, "dist", "electron");
    if (process.platform === "win32")
      await copyFile(process.execPath, executable);
    else await symlink(process.execPath, executable);
    const cli = join(directory, "maintenance.mjs");
    await build({
      entryPoints: ["src/desktop/worker/worker-maintenance-cli.ts"],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const doctor = spawn(process.execPath, [cli, "doctor", directory], {
      env: { ...process.env, ASTER_DATA_DIR: directory },
    });
    let output = "";
    doctor.stdout.on("data", (text: Buffer) => {
      output += text.toString();
    });
    doctor.stderr.on("data", (text: Buffer) => {
      output += text.toString();
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      doctor.once("error", reject);
      doctor.once("close", resolve);
    });
    assert.equal(
      status,
      2,
      "ordinary dev must refuse to take over an old worker",
    );
    assert.match(output, /旧 Worker 占用/);
    assert.doesNotMatch(output, /正在运行 v\d/);
    assert.match(output, /从原入口明确停止；未自动接管/);
    assert.equal(stops, 0, "doctor must not stop the backend");
    assert.doesNotMatch(
      output,
      new RegExp(token),
      "diagnostics must not expose the capability token",
    );
    let stopped = false;
    const stop = stopWorker(directory, 3000).then(() => {
      stopped = true;
    });
    await released;
    await worker.close();
    await delay(150);
    assert.equal(stopped, false, "supervisor still owns the directory");
    await supervisor.close();
    await stop;
    assert.equal(stops, 1);
  } finally {
    await worker.close();
    await supervisor.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

await test("restart waits for an owner even if endpoint publication is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-unpublished-owner-"));
  const owner = await ownDirectory(directory, "worker");
  const supervisor = await ownDirectory(directory, "supervisor");
  try {
    await assert.rejects(stopWorker(directory, 150), /尚未释放数据目录/);
    await owner.close();
    await assert.rejects(stopWorker(directory, 150), /尚未释放数据目录/);
    await supervisor.close();
    await stopWorker(directory, 150);
  } finally {
    await owner.close();
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a mismatched live identity is never stopped, while a stale endpoint is not a running worker", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "aster-maintenance-identity-"),
  );
  let writes = 0;
  const token = "b".repeat(64);
  const server = createServer((request, response) => {
    if (request.method === "POST") writes++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ pid: process.pid }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      join(directory, "endpoint.json"),
      JSON.stringify({
        pid: process.pid + 1,
        port: address.port,
        token,
      }),
    );
    assert.equal((await inspectWorker(directory)).state, "unverified");
    await assert.rejects(stopWorker(directory), /身份不匹配/);
    assert.equal(writes, 0);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal((await inspectWorker(directory)).state, "stale");
    await stopWorker(directory, 1000);
    await writeFile(join(directory, "endpoint.json"), "invalid json");
    assert.equal((await inspectWorker(directory)).state, "unverified");
    await assert.rejects(stopWorker(directory));
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

await test("restart waits beyond a brief health timeout and only then sends an authenticated stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-busy-worker-"));
  const owner = await ownDirectory(directory, "worker");
  let stops = 0;
  const token = "c".repeat(64);
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      const timer = setTimeout(
        () =>
          response.end(
            JSON.stringify({
              pid: process.pid,
            }),
          ),
        2200,
      );
      response.once("close", () => clearTimeout(timer));
    } else {
      stops++;
      response.end("{}");
      void owner.close();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      join(directory, "endpoint.json"),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        token,
      }),
    );
    const initial = await inspectWorker(directory);
    assert.equal(initial.state, "unverified");
    if (initial.state === "unverified")
      assert.match(initial.message, /健康检查超时/);
    assert.equal(stops, 0);
    await stopWorker(directory, 5000);
    assert.equal(stops, 1);
  } finally {
    await owner.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
