import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Store } from "../src/storage/store.js";
import type { Command } from "../src/shared/commands.js";
import { pluginContentSchema } from "../src/shared/tools/plugins.js";
import { PluginService } from "../src/plugins/service.js";
const execute = (store: Store, command: Command) =>
  store.execute({ id: randomUUID(), command });
const content = pluginContentSchema.parse({
  name: "demo",
  description: "示例",
  version: "1",
  format: "claude",
  skills: [
    { name: "demo:a", description: "A", body: "正文 A" },
    { name: "demo:b", description: "B", body: "正文 B" },
  ],
  servers: {},
  variables: [],
  warnings: [],
  files: {},
});
await test("installation is atomic, idempotent, scoped, and uninstall preserves edited skills", () => {
  const store = new Store(":memory:");
  try {
    const bot = execute(store, {
      type: "bot.create",
      name: "A",
      description: "",
    });
    const other = execute(store, {
      type: "bot.create",
      name: "B",
      description: "",
    });
    assert.ok(bot.id && other.id);
    const id = randomUUID();
    const installed = store.plugins.install(bot.id, id, content, {}, false);
    assert.deepEqual(
      store.plugins.install(bot.id, id, content, {}, false),
      installed,
    );
    assert.equal(store.skillCatalog([bot.id]).length, 2);
    assert.throws(
      () => store.plugins.install(bot.id!, randomUUID(), content, {}, false),
      /同名/,
    );
    assert.throws(() => store.plugins.remove(other.id!, id), /不属于/);
    assert.equal(store.plugins.list([other.id]).length, 0);
    const skill = store.skillCatalog([bot.id])[0];
    assert.ok(skill);
    execute(store, { type: "skill.save", ...skill, body: "用户编辑的新正文" });
    store.plugins.remove(bot.id, id);
    assert.equal(store.plugins.list([bot.id]).length, 0);
    assert.equal(store.skillCatalog([bot.id]).length, 1);
    assert.equal(
      store.skillContent({ ...skill, revision: 2 }).body,
      "用户编辑的新正文",
    );
    const conflict = {
      ...content,
      name: "different",
      skills: [
        { name: "fresh", description: "新增", body: "新增" },
        { name: skill.name, description: "冲突", body: "冲突" },
      ],
    };
    assert.throws(
      () => store.plugins.install(bot.id!, randomUUID(), conflict, {}, false),
      /同名/,
    );
    assert.equal(store.skillCatalog([bot.id]).length, 1);
    assert.equal(store.plugins.list([bot.id]).length, 0);
  } finally {
    store.close();
  }
});
await test("native import preview is bound to epoch and Bot and installs immutable content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-plugin-draft-"));
  const store = new Store(":memory:");
  const service = new PluginService(store);
  try {
    await mkdir(join(directory, ".claude-plugin"));
    await writeFile(
      join(directory, ".claude-plugin", "plugin.json"),
      '{"name":"first"}',
    );
    const bot = execute(store, {
      type: "bot.create",
      name: "A",
      description: "",
    });
    assert.ok(bot.id);
    const signal = new AbortController().signal;
    await assert.rejects(
      service.request(
        {
          action: "prepare",
          botId: bot.id,
          root: directory,
          epoch: randomUUID(),
        },
        signal,
      ),
      /切换/,
    );
    const prepared = await service.request(
      {
        action: "prepare",
        botId: bot.id,
        root: directory,
        epoch: store.cursor().epoch,
      },
      signal,
    );
    assert.ok(prepared.preview);
    await writeFile(
      join(directory, ".claude-plugin", "plugin.json"),
      '{"name":"second"}',
    );
    const installed = await service.request(
      {
        action: "install",
        botId: bot.id,
        id: prepared.preview.id,
        epoch: prepared.preview.epoch,
        variables: {},
        enableTools: false,
      },
      signal,
    );
    assert.equal(installed.plugins[0]?.name, "first");
    assert.ok(!JSON.stringify(installed).includes("files"));
    service.close();
    await assert.rejects(
      service.request({ action: "list", botId: bot.id }, signal),
    );
  } finally {
    service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("backup restore retains plugin snapshots but disables MCP and fences pending and started calls", async () => {
  const { saveDatabaseBackup, scheduleRestore, applyPendingRestore } =
    await import("../src/storage/backup/backup.js");
  const directory = await mkdtemp(join(tmpdir(), "aster-plugin-restore-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-plugin-restore-backup-"));
  let store = new Store(join(directory, "aster.sqlite"));
  try {
    const bot = execute(store, {
      type: "bot.create",
      name: "Backup",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    const pluginId = randomUUID(),
      bundle = {
        ...content,
        servers: { local: { command: "node", args: [], env: {} } },
        files: {
          "resource.txt": Buffer.from("saved snapshot").toString("base64"),
        },
      };
    store.plugins.install(bot.id, pluginId, bundle, {}, true);
    execute(store, {
      type: "message.send",
      conversationId: bot.conversationId,
      text: "pending",
    });
    const job = store.runs.claim();
    assert.ok(job);
    const operation = {
      action: "call" as const,
      pluginId,
      server: "local",
      tool: "fixture",
      arguments: {},
    };
    const pending = store.pluginCalls.create(job, "pending", "demo", operation);
    const running = store.pluginCalls.create(job, "running", "demo", operation);
    store.pluginCalls.decide(bot.id, running.id, true);
    assert.equal(store.pluginCalls.claim(job, running.id), true);
    const backup = join(outside, "backup.sqlite");
    await saveDatabaseBackup(directory, backup);
    store.close();
    scheduleRestore(directory, { kind: "file", path: backup });
    await applyPendingRestore(directory);
    store = new Store(join(directory, "aster.sqlite"));
    assert.equal(store.plugins.list([bot.id])[0]?.enabled, false);
    assert.throws(() => store.plugins.execution(bot.id!, pluginId), /尚未启用/);
    assert.equal(store.pluginCalls.get(pending.id).status, "cancelled");
    assert.equal(store.pluginCalls.get(running.id).status, "unknown");
    store.plugins.configure(bot.id, pluginId, true);
    assert.equal(
      Buffer.from(
        store.plugins.execution(bot.id, pluginId).content.files[
          "resource.txt"
        ]!,
        "base64",
      ).toString(),
      "saved snapshot",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

await test("a failed run that already made a plugin call cannot be retried", () => {
  // Contract owner: Store run.retry -> plugin_calls. Plugin calls live in their own table and
  // their assistant message has no toolJson, so the generic tool check does not see them.
  const store = new Store(":memory:");
  try {
    const bot = execute(store, {
      type: "bot.create",
      name: "Retry",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    const pluginId = randomUUID();
    store.plugins.install(
      bot.id,
      pluginId,
      {
        ...content,
        servers: { local: { command: "node", args: [], env: {} } },
      },
      {},
      true,
    );
    const sent = execute(store, {
      type: "message.send",
      conversationId: bot.conversationId,
      text: "call plugin",
    });
    const job = store.runs.claim();
    assert.ok(job && sent.id);
    store.pluginCalls.create(job, "call-1", "demo", {
      action: "call",
      pluginId,
      server: "local",
      tool: "fixture",
      arguments: {},
    });
    store.runs.finish(job.id, "failed", "boom");
    assert.throws(
      () => execute(store, { type: "run.retry", runId: sent.id! }),
      /副作用/,
    );
    const assistant = store.views
      .snapshot({ conversationId: bot.conversationId })
      .messages.find((m) => m.role === "assistant");
    assert.ok(assistant);
    assert.equal(
      store.pluginCalls.forMessage(assistant.id)?.pluginId,
      pluginId,
    );
  } finally {
    store.close();
  }
});
