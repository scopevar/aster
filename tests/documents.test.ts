import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DocumentReader } from "../src/documents/reader.js";
import { DocumentSession } from "../src/documents/service.js";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";
import { sampleWord } from "./helpers/office.js";
import { samplePdf } from "./helpers/pdf.js";

const reader = () =>
  new DocumentReader(
    new URL("../dist/documents/office-worker.js", import.meta.url),
  );
const envelope = (command: Command) => ({
  id: randomUUID(),
  command,
});
const signal = () => new AbortController().signal;

// PDF parsing is owned by the sandbox; retain the old boundary's explicit error.
await test("host PDF operations direct callers to sandbox Python", async () => {
  const pdf = reader();
  try {
    for (const operation of [
      { action: "info" },
      { action: "text", page: 1 },
      { action: "render", page: 2 },
    ] as const)
      await assert.rejects(
        pdf.read(samplePdf("TEXT", "SCAN"), operation, signal()),
        /Python/,
      );
  } finally {
    await pdf.close();
  }
});

await test("document reads enforce delivered scope, deduplicate receipts and recover interrupted parsing without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-documents-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  const pdf = reader();
  const sessions: DocumentSession[] = [];
  try {
    const a = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      envelope({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.id && a.conversationId && b.id && b.conversationId);
    const bytes = sampleWord("PRIVATE");
    const upload = (conversationId: string) =>
      store.files.registerAttachment(
        { id: randomUUID(), conversationId, name: "proof.docx" },
        bytes,
      );
    const received = upload(a.conversationId),
      draft = upload(a.conversationId),
      privateB = upload(b.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: a.conversationId,
        text: "read",
        attachmentIds: [received.id],
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const future = upload(a.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: a.conversationId,
        text: "later",
        attachmentIds: [future.id],
      }),
    );
    const session = new DocumentSession(store, pdf, job);
    sessions.push(session);
    const list = await session.request(
      { callId: "list", operation: { action: "list" } },
      signal(),
    );
    assert.ok(list.action === "list");
    assert.deepEqual(
      list.documents.map((file) => file.id),
      [received.id],
    );
    for (const id of [draft.id, privateB.id, future.id])
      assert.throws(
        () =>
          session.request(
            { callId: id, operation: { action: "word.info", id } },
            signal(),
          ),
        /未向当前运行/,
      );
    const request = {
      callId: "text",
      operation: { action: "word.text", id: received.id, offset: 0, length: 7 },
    };
    const content = await session.request(request, signal());
    assert.ok(content.action === "word.text");
    assert.equal(content.text, "PRIVATE");
    assert.deepEqual(await session.request(request, signal()), content);
    assert.throws(
      () =>
        session.request(
          { ...request, operation: { ...request.operation, offset: 1 } },
          signal(),
        ),
      /改变参数/,
    );
    const messages = store.views.snapshot({
      conversationId: a.conversationId,
    }).messages;
    assert.equal(messages.filter((message) => message.document).length, 2);
    assert.ok(
      messages
        .filter((message) => message.document)
        .every((message) => message.text.includes("文档：")),
    );
    const controller = new AbortController();
    const operation = session.request(
      {
        callId: "cancel",
        operation: { action: "word.info", id: received.id },
      },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(operation, { name: "AbortError" });
    assert.equal(
      store.views.snapshot({ conversationId: a.conversationId }).messages.at(-1)
        ?.document?.status,
      "cancelled",
    );
    await session.close();
    store.documentOperations.documentBegin(job, "interrupted", {
      action: "word.info",
      id: received.id,
    });
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(
      store.views.snapshot({ conversationId: a.conversationId }).messages.at(-1)
        ?.document?.status,
      "failed",
    );
    assert.throws(
      () => store.documentOperations.documentContent(job, received.id),
      /运行已经结束/,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    for (const session of sessions) await session.close();
    await pdf.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group PDF scope excludes drafts, private attachments and queued future messages, then revokes finished turns", async () => {
  const store = new Store(":memory:");
  try {
    const a = store.execute(
        envelope({ type: "bot.create", name: "A", description: "" }),
      ),
      b = store.execute(
        envelope({ type: "bot.create", name: "B", description: "" }),
      );
    assert.ok(a.id && a.conversationId && b.id);
    const group = store.execute(
      envelope({ type: "group.prepare", memberIds: [a.id, b.id] }),
    );
    assert.ok(group.conversationId);
    const upload = (conversationId: string) =>
      store.files.registerAttachment(
        { id: randomUUID(), conversationId, name: "scope.pdf" },
        samplePdf("SCOPE", "SCAN"),
      );
    const received = upload(group.conversationId),
      draft = upload(group.conversationId),
      privateFile = upload(a.conversationId);
    store.execute(
      envelope({
        type: "group.start",
        conversationId: group.conversationId,
        memberIds: [a.id, b.id],
        text: "read shared",
        attachmentIds: [received.id],
      }),
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    const future = upload(group.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: group.conversationId,
        recipientIds: [a.id],
        text: "future",
        attachmentIds: [future.id],
      }),
    );
    assert.deepEqual(
      store.documentOperations
        .documentList(turn)
        .documents.map((file) => file.id),
      [received.id],
    );
    for (const id of [draft.id, privateFile.id, future.id])
      assert.throws(
        () => store.documentOperations.documentContent(turn, id),
        /未向当前运行/,
      );
    store.runs.finishGroupTurn(turn, "completed", null);
    assert.throws(
      () => store.documentOperations.documentContent(turn, received.id),
      /运行已经结束/,
    );
    const second = store.runs.nextGroupTurn(parent);
    assert.ok(second);
    assert.deepEqual(
      store.documentOperations
        .documentList(second)
        .documents.map((file) => file.id),
      [received.id],
    );
  } finally {
    store.close();
  }
});

await test("runtime cancellation revokes the document capability immediately and drains the actual parser before scope close", async () => {
  const store = new Store(":memory:"),
    pdf = reader();
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "Cancel PDF", description: "" }),
    );
    assert.ok(bot.conversationId);
    const file = store.files.registerAttachment(
      {
        id: randomUUID(),
        conversationId: bot.conversationId,
        name: "cancel.docx",
      },
      sampleWord("CANCEL"),
    );
    store.execute(
      envelope({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "read",
        attachmentIds: [file.id],
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const tools = new ToolService(store, 18000, pdf);
    const controller = new AbortController(),
      scope = tools.open(job, controller.signal);
    const pending = tools.documents(
      scope.connection.token,
      { callId: "read", operation: { action: "word.info", id: file.id } },
      signal(),
    );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    assert.throws(
      () =>
        tools.documents(
          scope.connection.token,
          { callId: "late", operation: { action: "list" } },
          signal(),
        ),
      /授权已结束/,
    );
    await scope.close();
    await rejected;
    assert.equal(
      store.views
        .snapshot({ conversationId: bot.conversationId })
        .messages.at(-1)?.document?.status,
      "cancelled",
    );
  } finally {
    await pdf.close();
    store.close();
  }
});
