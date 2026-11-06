import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConnections } from "../src/agent/connections.js";
import {
  agentConnectionSchema,
  agentConnectionsConfigSchema,
} from "../src/shared/agent-connections.js";
import { LiveAgent } from "../src/agent/live.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { configureProvider } from "../src/agent/pi-model.js";
import { PiCredentials } from "../src/agent/pi-credentials.js";

await test(
  "unchanged credential metadata avoids repeated OS decryption and changed files never reuse stale providers",
  { skip: process.platform !== "win32" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "aster-connection-metadata-"));
    const path = join(home, "pi-auth.sealed");
    const status = () =>
      service.request({ action: "status" }, AbortSignal.timeout(10000));
    const service = new AgentConnections(home);
    try {
      const credentials = new PiCredentials(home);
      t.diagnostic("Sealing the first credential with Windows protection");
      await credentials.modify("first", async () => ({
        type: "api_key",
        key: "first-metadata-fixture",
      }));
      const first = await readFile(path);
      t.diagnostic("Reading the initial provider metadata");
      assert.deepEqual((await status()).storedProviders, ["first"]);
      t.diagnostic("Sealing changed credentials with Windows protection");
      await credentials.modify("second", async () => ({
        type: "api_key",
        key: "second-metadata-fixture",
      }));
      const second = await readFile(path);
      await writeFile(path, first);
      const originalPath = process.env.PATH;
      t.diagnostic("Checking cached and changed metadata without PowerShell");
      try {
        // Removing PowerShell from this test process proves a repeat status
        // can use public metadata without launching the OS decryptor again.
        process.env.PATH = "";
        assert.deepEqual((await status()).storedProviders, ["first"]);
        await writeFile(path, second);
        await assert.rejects(status(), /应用凭证库无法读取/);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      t.diagnostic("Reading changed credentials after restoring PATH");
      assert.deepEqual((await status()).storedProviders, ["first", "second"]);
      await rm(path);
      assert.deepEqual((await status()).storedProviders, []);
      await writeFile(path, "invalid sealed credentials");
      await assert.rejects(status(), /应用凭证库无法读取/);
      await writeFile(path, second);
      assert.deepEqual((await status()).storedProviders, ["first", "second"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

await test("Pi settings save atomically, reject stale revisions and expose only credential references", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-pi-settings-"));
  try {
    let changes = 0;
    const service = new AgentConnections(home, () => {
      changes++;
    });
    const before = service.status();
    const entry = agentConnectionSchema.parse({
      id: "local",
      provider: "local",
      model: "local-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      auth: "none",
    });
    const saved = await service.request(
      {
        action: "save",
        revision: before.revision,
        config: { defaultAgent: "local", connections: [entry] },
      },
      AbortSignal.timeout(5000),
    );
    assert.equal(changes, 1);
    assert.equal(saved.config.connections[0]?.provider, "local");
    assert.match(saved.notice, /下一次运行/);
    assert.notEqual(saved.revision, before.revision);
    await assert.rejects(
      service.request(
        { action: "save", revision: before.revision, config: before.config },
        AbortSignal.timeout(5000),
      ),
      /配置已修改/,
    );
    assert.equal(changes, 1);
    assert.deepEqual(
      JSON.parse(await readFile(modelConfigPath(home), "utf8")),
      saved.config,
    );
    const checked = await service.request(
      { action: "check", connection: entry },
      AbortSignal.timeout(5000),
    );
    assert.match(checked.notice, /未向模型发出请求/);
    await writeFile(modelConfigPath(home), "{invalid");
    assert.throws(() => service.status(), /Pi 模型配置无效/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
await test("Pi configuration rejects launch parameters, raw secrets and unsafe endpoints", () => {
  const entry = {
    id: "local",
    provider: "local",
    model: "m",
    auth: "none",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/v1",
  };
  for (const extra of [
    { command: "agent" },
    { env: { API_KEY: "secret" } },
    { apiKey: "secret" },
    { protocol: "acp" },
  ])
    assert.equal(
      agentConnectionSchema.safeParse({ ...entry, ...extra }).success,
      false,
    );
  for (const baseUrl of [
    "http://remote.test/v1",
    "https://key:secret@example.com/v1",
    "file:///tmp/model",
    "https://example.com/v1?api_key=secret",
  ])
    assert.equal(
      agentConnectionSchema.safeParse({ ...entry, baseUrl }).success,
      false,
    );
  assert.throws(
    () =>
      agentConnectionsConfigSchema.parse({
        defaultAgent: "local",
        connections: [entry],
        retainCancelledContext: "false",
      }),
    /retainCancelledContext/,
  );
});

await test("empty Pi settings require adding a provider and remain empty after deleting the last connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-pi-empty-"));
  try {
    const service = new AgentConnections(home);
    const empty = service.status();
    assert.deepEqual(empty.config, { defaultAgent: "", connections: [] });
    assert.equal(empty.active, "尚未添加供应商");
    assert.throws(() => new LiveAgent(home).capture(), /添加供应商/);
    assert.equal(
      agentConnectionsConfigSchema.safeParse({
        defaultAgent: "missing",
        connections: [],
      }).success,
      false,
    );
    const entry = agentConnectionSchema.parse({
      id: "local",
      provider: "local",
      model: "fixture",
      api: "openai-completions",
      auth: "none",
      baseUrl: "http://localhost:11434/v1",
    });
    assert.equal(
      agentConnectionsConfigSchema.safeParse({
        defaultAgent: "",
        connections: [entry],
      }).success,
      false,
    );
    const added = await service.request(
      {
        action: "save",
        revision: empty.revision,
        config: { defaultAgent: entry.id, connections: [entry] },
      },
      AbortSignal.timeout(5000),
    );
    assert.match(added.active, /fixture/);
    const removed = await service.request(
      { action: "save", revision: added.revision, config: empty.config },
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(new AgentConnections(home).status().config, empty.config);
    assert.equal(removed.active, "尚未添加供应商");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("configured compatible providers use Pi's native API key login mechanism", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  configureProvider(
    runtime,
    agentConnectionSchema.parse({
      id: "custom",
      provider: "custom",
      model: "model",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      auth: "stored",
    }),
  );
  await runtime.login("custom", "api_key", {
    prompt: async () => "fixture-secret",
    notify: () => {},
  });
  assert.deepEqual(await runtime.listCredentials(), [
    { providerId: "custom", type: "api_key" },
  ]);
});
