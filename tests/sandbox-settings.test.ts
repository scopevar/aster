import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxProcess } from "../src/sandbox/process.js";
import { SandboxResources } from "../src/sandbox/resources.js";
import { SandboxNetworkDiagnostics } from "../src/sandbox/network-test.js";
import { SandboxSettingsStore } from "../src/sandbox/settings-store.js";
import {
  sandboxSettingsStatusSchema,
  defaultSandboxNetworkConfiguration,
} from "../src/shared/tools/sandbox-settings.js";
import { workerRoutes } from "../src/shared/protocol.js";
import { callWorker } from "../src/worker/client.js";
import { startWorker } from "../src/worker/server.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";

await test("authenticated sandbox settings persist across daemon restart and reject stale/invalid writes", async (t) => {
  // SDK preparation is external; real HTTP authentication, schema, persistence and account scope own this contract.
  t.mock.method(SandboxProcess.prototype, "prepare", async () => {});
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "sandbox-settings-"));
  let worker = await startWorker(directory, { port: 0 });
  const request = async (body: unknown) =>
    sandboxSettingsStatusSchema.parse(
      await callWorker(worker.endpoint, workerRoutes.sandboxSettings, body),
    );
  try {
    const denied = await fetch(
      `http://127.0.0.1:${worker.endpoint.port}${workerRoutes.sandboxSettings}`,
      { method: "POST", body: JSON.stringify({ action: "status" }) },
    );
    assert.equal(denied.status, 401);
    await denied.body?.cancel();
    const first = await request({ action: "status" });
    assert.deepEqual(first.configuration, defaultSandboxNetworkConfiguration());
    assert.equal(first.enabled, true);
    await assert.rejects(
      request({
        action: "save",
        revision: first.revision,
        configuration: {
          dns: { mode: "auto" },
          proxy: { protocol: "http", address: "user:secret@127.0.0.1:7897" },
        },
      }),
    );
    const configuration = {
      dns: { mode: "custom", servers: ["1.1.1.1:53"] },
      proxy: { protocol: "http", address: "127.0.0.1:7897" },
    };
    const saved = await request({
      action: "save",
      revision: first.revision,
      configuration,
    });
    assert.deepEqual(saved.configuration, configuration);
    await assert.rejects(
      request({
        action: "save",
        revision: first.revision,
        configuration: first.configuration,
      }),
      /已修改/,
    );
    await worker.stop();
    worker = await startWorker(directory, { port: 0 });
    assert.deepEqual(
      (await request({ action: "status" })).configuration,
      configuration,
    );
    const path = join(
      localWorkspaceDirectory(directory),
      "scripts",
      "network.json",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), configuration);
    await worker.stop();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), configuration);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("diagnostics report partial DNS/HTTPS failure and wait for VM cleanup before releasing their channel", async (t) => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "network-diagnostic-"));
  const resources = new SandboxResources(directory);
  t.mock.method(SandboxProcess.prototype, "prepare", async () => {});
  t.mock.method(
    SandboxProcess.prototype,
    "open",
    async (config: Parameters<SandboxProcess["open"]>[0]) => {
      assert.deepEqual(await readdir(config.workspace), []);
      assert.deepEqual(await readdir(config.inputs), []);
    },
  );
  t.mock.method(SandboxProcess.prototype, "execute", async () => ({
    status: "failed" as const,
    stdout:
      '{"stage":"dns","state":"passed","detail":"93.184.216.34"}\n{"stage":"https","state":"failed","detail":"proxy refused"}\n',
    stderr: "",
    exitCode: 1,
    truncated: false,
    durationMs: 1,
  }));
  await resources.wait(AbortSignal.timeout(5000), () => {});
  let release: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(SandboxProcess.prototype, "close", () => cleanup);
  const diagnostics = new SandboxNetworkDiagnostics(
    directory,
    resources,
    async () => ["198.18.0.124"],
  );
  const id = randomUUID(),
    configuration = defaultSandboxNetworkConfiguration();
  try {
    diagnostics.start(id, "example.com", configuration);
    for (
      let attempt = 0;
      diagnostics.state?.https.state === "pending" && attempt < 100;
      attempt++
    )
      await delay(25);
    assert.equal(diagnostics.state?.dns.state, "passed");
    assert.equal(diagnostics.state?.https.state, "failed");
    assert.equal(diagnostics.state?.state, "running");
    assert.throws(
      () => diagnostics.start(randomUUID(), "example.com", configuration),
      /诊断正在运行/,
    );
    release();
    for (let attempt = 0; diagnostics.running && attempt < 100; attempt++)
      await delay(10);
    assert.equal(diagnostics.state?.state, "failed");
    assert.equal(diagnostics.state?.detail, "proxy refused");
    assert.deepEqual(await readdir(join(directory, "network-tests")), []);
    const settings = new SandboxSettingsStore(join(directory, "network.json"));
    const before = await settings.read();
    await assert.rejects(
      settings.save(before.revision, configuration, AbortSignal.abort()),
    );
    assert.equal((await settings.read()).revision, before.revision);
  } finally {
    release();
    await diagnostics.stop();
    await resources.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
