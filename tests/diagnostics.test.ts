import { maxDatabaseVersion } from "../src/shared/backup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { workerRoutes } from "../src/shared/protocol.js";
import { saveDiagnostics } from "../src/diagnostics/save.js";
import { DesktopDiagnostics } from "../src/desktop/native/diagnostics.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import {
  diagnosticsSchema,
  workerDiagnosticsSchema,
} from "../src/shared/diagnostics.js";
import { Store } from "../src/storage/store.js";
import { startWorker } from "../src/worker/server.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";

const request = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });
const version = {
  appVersion: "0.1.0",
  nodeVersion: process.versions.node,
  electronVersion: "44.4.5",
  platform: "win32",
  architecture: "x64",
} as const;
const inspect = () => ({ requestId: randomUUID(), action: "inspect" as const });

await test("real diagnostic HTTP and desktop collection expose only strict aggregates, excluding private canaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-diagnostic-"));
  const canary = `PRIVATE_${randomUUID()}`;
  await mkdir(localWorkspaceDirectory(directory), { recursive: true });
  const store = new Store(
    join(localWorkspaceDirectory(directory), "aster.sqlite"),
  );
  const bot = store.execute(
    request({
      type: "bot.create",
      name: canary.slice(0, 40),
      description: canary,
    }),
  );
  assert.ok(bot.id && bot.conversationId);
  store.execute(
    request({
      type: "message.send",
      conversationId: bot.conversationId,
      text: canary,
    }),
  );
  const job = store.runs.claim();
  assert.ok(job);
  store.runs.output.writeText(job, "private-output", canary, true);
  store.runs.finish(job.id, "failed", `credential=${canary}`);
  store.files.registerAttachment(
    {
      id: randomUUID(),
      conversationId: bot.conversationId,
      name: `${canary}.txt`,
    },
    Buffer.from(canary),
  );
  store.execute(
    request({
      type: "skill.save",
      id: randomUUID(),
      botId: bot.id,
      revision: 0,
      name: "私密技能",
      description: canary,
      body: canary,
    }),
  );
  store.close();
  const worker = await startWorker(directory, { port: 0 });
  const service = new DesktopDiagnostics(directory, version);
  try {
    const url = `http://127.0.0.1:${worker.endpoint.port}/diagnostics`;
    const headers = { Authorization: `Bearer ${worker.endpoint.token}` };
    for (const denied of [
      {},
      { ...headers, Origin: "https://example.invalid" },
    ]) {
      const response = await fetch(url, { headers: denied });
      assert.equal(response.status, 401);
      await response.text();
    }
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const diagnostic = workerDiagnosticsSchema.parse(await response.json());
    assert.deepEqual(diagnostic.storage.records, {
      bots: 1,
      conversations: 1,
      messages: 2,
      attachments: 1,
      skills: 1,
      templates: 0,
    });
    assert.deepEqual(diagnostic.storage.runs, [{ state: "failed", count: 1 }]);
    assert.equal(diagnostic.storage.schemaVersion, maxDatabaseVersion);
    assert.ok(diagnostic.process.rssBytes > 0);
    const second = workerDiagnosticsSchema.parse(
      await (await fetch(url, { headers })).json(),
    );
    assert.equal(
      second.sampledAt,
      diagnostic.sampledAt,
      "repeated sampling shares a bounded five-second cache",
    );
    const extra = await fetch(`${url}?includeSecrets=true`, { headers });
    assert.equal(extra.status, 400);
    await extra.text();
    const result = await service.request(inspect());
    assert.equal(result.status, "inspected");
    assert.ok(result.status === "inspected" && result.report.worker.available);
    const report = result.report,
      json = JSON.stringify(report);
    for (const secret of [
      canary,
      bot.id,
      bot.conversationId,
      job.id,
      worker.endpoint.token,
      directory,
    ])
      assert.equal(json.includes(secret), false);
    assert.equal(
      diagnosticsSchema.safeParse({ ...report, secret: canary }).success,
      false,
    );
    const target = join(directory, "diagnostic.json");
    const saved = await service.request(
      { requestId: randomUUID(), action: "save" },
      async () => target,
    );
    assert.ok(saved.status === "saved");
    const parsed = diagnosticsSchema.parse(
      JSON.parse(await readFile(target, "utf8")),
    );
    assert.deepEqual(parsed, saved.report);
    assert.equal(saved.name, "diagnostic.json");
    const before = await readFile(target, "utf8");
    const unexpectedField = { ...report, secret: canary };
    await assert.rejects(
      saveDiagnostics(target, unexpectedField, new AbortController().signal),
    );
    assert.equal(await readFile(target, "utf8"), before);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(saveDiagnostics(target, report, controller.signal), {
      name: "AbortError",
    });
    assert.equal(await readFile(target, "utf8"), before);
    const invalid = join(directory, "directory.json");
    await mkdir(invalid);
    await assert.rejects(
      saveDiagnostics(invalid, report, new AbortController().signal),
      /普通 JSON/,
    );
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith(".aster-diagnostic-"),
      ),
      false,
    );
  } finally {
    await service.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("diagnostics cancel owned requests, serialize native selection and retain a truthful offline snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-diagnostic-offline-"));
  const service = new DesktopDiagnostics(directory, version);
  let release: ((value: string | null) => void) | undefined;
  try {
    const inspected = await service.request(inspect());
    assert.ok(inspected.status === "inspected");
    assert.deepEqual(inspected.report.worker, {
      available: false,
      reason: "unreachable",
    });
    const target = join(directory, "keep.json");
    await writeFile(target, "existing content");
    let chooseBegan = () => {};
    const selected = new Promise<void>((resolve) => {
      chooseBegan = resolve;
    });
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const id = randomUUID();
    const saving = service.request(
      { requestId: id, action: "save" },
      async () => {
        chooseBegan();
        return pending;
      },
    );
    await selected;
    assert.throws(() => service.request(inspect()), /已有诊断/);
    service.cancel(id);
    release?.(target);
    assert.deepEqual(await saving, { status: "cancelled" });
    assert.equal(await readFile(target, "utf8"), "existing content");
    const cancelled = service.request(inspect());
    await service.close();
    assert.deepEqual(await cancelled, { status: "cancelled" });
    assert.throws(() => service.request(inspect()), /关闭/);
  } finally {
    release?.(null);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("diagnostics do not reuse a sample after the Store epoch changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-diagnostic-epoch-"));
  const first = new Store(join(directory, "first.sqlite"));
  const second = new Store(join(directory, "second.sqlite"));
  try {
    second.execute(
      request({ type: "bot.create", name: "Second", description: "" }),
    );
    const { queryRoutes } = await import("../src/worker/query-routes.js");
    const routes = queryRoutes({
      capability: { agent: "unchecked", detail: "fixture", accountType: null },
      scheduler: undefined,
      server: createServer(),
    });
    const diagnostics = routes.find(
      (route) => route.path === workerRoutes.diagnostics,
    );
    assert.ok(diagnostics);
    const inspectStore = async (store: Store) => {
      let body: unknown;
      const response = {
        writableEnded: false,
        destroyed: false,
        writeHead() {},
        end(value: string) {
          body = JSON.parse(value);
        },
      } as unknown as ServerResponse;
      await diagnostics.run({
        request: {} as IncomingMessage,
        response,
        url: new URL("http://localhost/diagnostics"),
        signal: new AbortController().signal,
        store,
        runtime: undefined as never,
      });
      return workerDiagnosticsSchema.parse(body);
    };
    const sampledAt = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: sampledAt });
    const firstSample = await inspectStore(first);
    assert.equal(firstSample.storage.records.bots, 0);
    const secondSample = await inspectStore(second);
    assert.equal(secondSample.storage.records.bots, 1);
    assert.equal(firstSample.sampledAt, sampledAt);
    assert.equal(secondSample.sampledAt, sampledAt);
    assert.notEqual(
      secondSample.storage.records.bots,
      firstSample.storage.records.bots,
    );
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
