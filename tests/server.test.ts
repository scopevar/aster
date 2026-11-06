import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorker } from "../src/worker/server.js";
import { randomUUID } from "node:crypto";
import { sampleWord } from "./helpers/office.js";
import { officeResultSchema } from "../src/shared/files/office.js";
import { DesktopDocuments } from "../src/desktop/native/documents.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { resultSchema } from "../src/shared/core.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

await test("loopback worker authenticates every request and rejects browser origins and malformed contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-server-"));
  const worker = await startWorker(directory, { port: 0 });
  try {
    const url = `http://127.0.0.1:${worker.endpoint.port}`;
    assert.equal((await fetch(url + "/health")).status, 401);
    const headers = { Authorization: `Bearer ${worker.endpoint.token}` };
    for (const requestHeaders of [
      {},
      headers,
      { Authorization: `Bearer ${"0".repeat(64)}` },
      { ...headers, Origin: "https://malicious.invalid" },
    ]) {
      for (const [route, input] of [
        ["scripts", { operation: { action: "status" } }],
        ["question", { question: { prompt: "选择", options: ["甲", "乙"] } }],
        ["skills", { operation: { action: "list" } }],
        ["plugins", { operation: { action: "list" } }],
        ["documents", { operation: { action: "list" } }],
        ["routines", { operation: { action: "list" } }],
      ] as const) {
        const rejected = await fetch(url + `/tools/${route}`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ callId: "unauthorized", ...input }),
        });
        assert.equal(rejected.status, 401);
        await rejected.text();
      }
    }
    const health = await fetch(url + "/health", { headers });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { pid: worker.endpoint.pid });
    assert.equal(Object.hasOwn(worker.endpoint, "version"), false);
    const snapshot = await fetch(url + "/snapshot", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(snapshot.status, 200);
    const update = await snapshot.json();
    assert.equal(update.changed, true);
    assert.equal(Object.hasOwn(update.snapshot, "version"), false);
    const oldHealth = await fetch(url + "/v20/health", { headers });
    assert.equal(oldHealth.status, 400);
    assert.equal((await oldHealth.json()).error.code, "not_found");
    const forgedText = await fetch(url + "/computer/text", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        requestId: randomUUID(),
        sequence: 1,
        connection: `ws://127.0.0.1:${worker.endpoint.port}/computer/stream/${"a".repeat(64)}`,
        text: "A guessed stream capability cannot send text",
      }),
    });
    assert.equal(forgedText.status, 400);
    assert.equal((await forgedText.json()).error.code, "not_found");
    assert.equal(
      (
        await fetch(url + "/health", {
          headers: { ...headers, Origin: "https://malicious.invalid" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/command", {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: "bad",
            command: { type: "shell" },
          }),
        })
      ).status,
      400,
    );
    await assert.rejects(
      startWorker(directory, { port: worker.endpoint.port }),
      /EADDRINUSE/,
    );
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("real streaming upload cannot commit after its cancellation, and content access checks conversation scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-upload-"));
  const worker = await startWorker(directory, { port: 0 });
  const base = `http://127.0.0.1:${worker.endpoint.port}`;
  const headers = { Authorization: `Bearer ${worker.endpoint.token}` };
  const command = async (command: Command) => {
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(envelopeSchema.parse({ id: randomUUID(), command })),
    });
    assert.equal(response.status, 200);
    return resultSchema.parse(await response.json());
  };
  let release: (() => void) | undefined;
  try {
    const created = await command({
      type: "bot.create",
      name: "Upload",
      description: "",
    });
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    assert.ok(created.id);
    const other = (
      await command({ type: "conversation.create", botId: created.id })
    ).conversationId;
    assert.ok(other);
    const id = randomUUID();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      began = resolve;
    });
    let stage = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (stage++ === 0) {
          controller.enqueue(Buffer.from("first chunk"));
          return;
        }
        began?.();
        await gate;
        controller.enqueue(Buffer.from("last chunk"));
        controller.close();
      },
    });
    const requestInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        ...headers,
        "x-attachment-id": id,
        "x-conversation-id": conversationId,
        "x-file-name": "cancel.txt",
      },
      body: stream,
      duplex: "half",
    };
    const uploading = fetch(`${base}/attachments/upload`, requestInit);
    await firstChunk;
    await command({ type: "attachment.remove", id, conversationId });
    release?.();
    const result = await uploading;
    assert.equal(result.status, 400);
    assert.match(await result.text(), /取消/);
    const state = await workerSnapshot(worker.endpoint, { conversationId });
    assert.equal(
      state.conversations.find((c) => c.id === conversationId)?.draftAttachments
        .length,
      0,
    );
    const savedId = randomUUID();
    const uploaded = await fetch(`${base}/attachments/upload`, {
      method: "POST",
      headers: {
        ...headers,
        "x-attachment-id": savedId,
        "x-conversation-id": conversationId,
        "x-file-name": "input.txt",
      },
      body: "verified bytes",
    });
    assert.equal(uploaded.status, 200);
    await uploaded.json();
    const rejected = await fetch(
      `${base}/attachments/content?id=${savedId}&conversationId=${other}`,
      { headers },
    );
    assert.equal(rejected.status, 400);
    await rejected.text();
    const valid = await fetch(
      `${base}/attachments/content?id=${savedId}&conversationId=${conversationId}`,
      { headers },
    );
    assert.equal(valid.status, 200);
    await valid.text();
  } finally {
    release?.();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("actual Office preview transport permits owned drafts, rejects other conversations and origins, and closes cancellable desktop requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-office-http-"));
  const worker = await startWorker(directory, { port: 0 }),
    desktop = new DesktopDocuments(directory);
  const base = `http://127.0.0.1:${worker.endpoint.port}`,
    headers = {
      Authorization: `Bearer ${worker.endpoint.token}`,
      "Content-Type": "application/json",
    };
  try {
    const create = async (name: string) =>
      resultSchema.parse(
        await (
          await fetch(base + "/command", {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: randomUUID(),
              command: { type: "bot.create", name, description: "" },
            }),
          })
        ).json(),
      );
    const a = await create("Preview"),
      b = await create("Other");
    assert.ok(a.conversationId && b.conversationId);
    const id = randomUUID(),
      uploaded = await fetch(base + "/attachments/upload", {
        method: "POST",
        headers: {
          ...headers,
          "x-file-name": "proof.docx",
          "x-attachment-id": id,
          "x-conversation-id": a.conversationId,
        },
        body: sampleWord("HTTP_PREVIEW"),
      });
    assert.equal(uploaded.status, 200);
    await uploaded.json();
    const request = {
      requestId: randomUUID(),
      id,
      conversationId: a.conversationId,
      operation: { action: "word.text" as const, offset: 0, length: 120000 },
    };
    for (const deniedHeaders of [
      {},
      { ...headers, Origin: "https://not-authorized.invalid" },
    ]) {
      const response = await fetch(base + "/documents/preview", {
        method: "POST",
        headers: deniedHeaders,
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 401);
      await response.text();
    }
    const wrong = await fetch(base + "/documents/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, conversationId: b.conversationId }),
    });
    assert.equal(wrong.status, 400);
    await wrong.text();
    const actual = officeResultSchema.parse(await desktop.request(request));
    assert.ok(actual.action === "word.text");
    assert.match(actual.text, /HTTP_PREVIEW/);
    const cancel = { ...request, requestId: randomUUID() };
    const task = desktop.request(cancel),
      rejected = assert.rejects(task, { name: "AbortError" });
    desktop.cancel(cancel.requestId);
    await rejected;
    await desktop.close();
    assert.throws(
      () => desktop.request({ ...request, requestId: randomUUID() }),
      /关闭/,
    );
  } finally {
    await desktop.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
