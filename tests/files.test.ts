import { maxDatabaseVersion } from "../src/shared/backup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FileSession } from "../src/files/session.js";
import type { Command } from "../src/shared/commands.js";
import {
  fileResultSchema,
  type FileRequest,
} from "../src/shared/files/files.js";
import { Store } from "../src/storage/store.js";

const command = (command: Command) => ({
  id: randomUUID(),
  command,
});
const signal = () => new AbortController().signal;

await test("file scopes read actual bytes, page directories and revoke in-flight access without crossing conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-scoped-files-"));
  const store = new Store(join(directory, "db.sqlite"));
  let files: FileSession | undefined;
  try {
    const root = join(directory, "granted");
    const other = join(directory, "other");
    await mkdir(root);
    await mkdir(other);
    await writeFile(
      join(root, "notes.txt"),
      "真正的中文资料\n" + "a".repeat(70000),
    );
    await writeFile(join(other, "secret.txt"), "outside");
    for (let i = 0; i < 102; i++)
      await writeFile(join(root, `item-${i}.txt`), String(i));
    const created = store.execute(
      command({ type: "bot.create", name: "Reader", description: "" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    const grant = store.execute(
      command({ type: "directory.attach", conversationId, root }),
    );
    assert.ok(grant.id);
    store.execute(
      command({ type: "message.send", conversationId, text: "read" }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    files = new FileSession(store, job);
    const request = (operation: FileRequest["operation"]) =>
      files!.request({ callId: randomUUID(), operation }, signal());
    const first = await request({
      action: "list",
      grantId: grant.id,
      path: "",
      offset: 0,
    });
    assert.equal(first.action, "list");
    if (first.action !== "list") throw Error("wrong result");
    assert.equal(first.entries.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = await request({
      action: "list",
      grantId: grant.id,
      path: "",
      offset: 100,
    });
    assert.equal(second.action, "list");
    if (second.action !== "list") throw Error("wrong result");
    assert.equal(second.entries.length, 3);
    assert.equal(second.nextOffset, null);
    const read = await request({
      action: "read",
      grantId: grant.id,
      path: "notes.txt",
      encoding: "utf8",
      offset: 0,
    });
    if (read.action !== "read") throw Error("wrong result");
    assert.match(read.content, /^真正的中文资料/);
    assert.equal(read.nextOffset, 65536);
    const tail = await request({
      action: "read",
      grantId: grant.id,
      path: "notes.txt",
      encoding: "utf8",
      offset: 65536,
    });
    if (tail.action !== "read") throw Error("wrong result");
    assert.equal(tail.hash, read.hash);
    assert.equal(tail.nextOffset, null);
    assert.equal(
      read.content + tail.content,
      "真正的中文资料\n" + "a".repeat(70000),
    );
    for (const path of [
      "../other/secret.txt",
      "notes.txt:private",
      join(other, "secret.txt"),
    ])
      await assert.rejects(
        request({
          action: "read",
          grantId: grant.id,
          path,
          encoding: "utf8",
          offset: 0,
        }),
        /授权目录|备用数据流/,
      );
    await symlink(other, join(root, "redirect"), "junction");
    await assert.rejects(
      request({
        action: "read",
        grantId: grant.id,
        path: "redirect/secret.txt",
        encoding: "utf8",
        offset: 0,
      }),
      /链接/,
    );
    await link(join(other, "secret.txt"), join(root, "hard.txt"));
    await assert.rejects(
      request({
        action: "read",
        grantId: grant.id,
        path: "hard.txt",
        encoding: "utf8",
        offset: 0,
      }),
      /单一归属/,
    );
    const foreign = store.execute(
      command({ type: "bot.create", name: "Other", description: "" }),
    );
    assert.ok(foreign.conversationId);
    const foreignGrant = store.execute(
      command({
        type: "directory.attach",
        conversationId: foreign.conversationId,
        root: other,
      }),
    );
    assert.ok(foreignGrant.id);
    await assert.rejects(
      request({
        action: "read",
        grantId: foreignGrant.id,
        path: "secret.txt",
        encoding: "utf8",
        offset: 0,
      }),
      /不属于/,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "directory.revoke",
            id: foreignGrant.id!,
            conversationId,
          }),
        ),
      /不属于/,
    );
    const inFlight = request({
      action: "read",
      grantId: grant.id,
      path: "notes.txt",
      encoding: "utf8",
      offset: 0,
    });
    store.execute(
      command({ type: "directory.revoke", id: grant.id, conversationId }),
    );
    await assert.rejects(inFlight, /撤销/);
    assert.deepEqual(await request({ action: "grants" }), {
      action: "grants",
      grants: [],
    });
  } finally {
    await files?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("file saves commit one visible attachment per call, preserve bytes after restart and reject cancellation and changed replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-file-save-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  let files: FileSession | undefined;
  try {
    const created = store.execute(
      command({ type: "bot.create", name: "Writer", description: "" }),
    );
    assert.ok(created.conversationId);
    store.execute(
      command({
        type: "message.send",
        conversationId: created.conversationId,
        text: "save",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const scopeId = randomUUID();
    files = new FileSession(store, job, scopeId);
    const request = {
      callId: "save-1",
      operation: {
        action: "save",
        name: "answer.txt",
        encoding: "utf8",
        content: "实际成果\n",
      },
    };
    const first = await files.request(request, signal());
    assert.deepEqual(await files.request(request, signal()), first);
    await assert.rejects(
      files.request(
        { ...request, operation: { ...request.operation, content: "changed" } },
        signal(),
      ),
      /改变参数/,
    );
    await assert.rejects(
      files.request(
        {
          callId: "invalid",
          operation: {
            action: "save",
            name: "bytes.bin",
            encoding: "base64",
            content: "!!!",
          },
        },
        signal(),
      ),
      /base64/,
    );
    await files.close();
    store.close();
    store = new Store(path);
    files = new FileSession(store, job, scopeId);
    assert.deepEqual(await files.request(request, signal()), first);
    if (first.action !== "save") throw Error("wrong result");
    assert.equal(
      store.views
        .snapshot({ conversationId: job.conversationId })
        .messages.filter((m) => m.id === first.attachment.messageId).length,
      1,
    );
    assert.equal(
      Buffer.from(
        store.files.attachmentContent(job.conversationId, first.attachment.id)
          .bytes,
      ).toString(),
      "实际成果\n",
    );
    const bytes = Buffer.from([0, 255, 128, 42]);
    const binary = fileResultSchema.parse(
      await files.request(
        {
          callId: "binary",
          operation: {
            action: "save",
            name: "bytes.bin",
            encoding: "base64",
            content: bytes.toString("base64"),
          },
        },
        signal(),
      ),
    );
    if (binary.action !== "save") throw Error("wrong result");
    assert.deepEqual(
      Buffer.from(
        store.files.attachmentContent(job.conversationId, binary.attachment.id)
          .bytes,
      ),
      bytes,
    );
    await files.close();
    assert.throws(
      () => files!.request({ ...request, callId: "late" }, signal()),
      /abort/i,
    );
    files = new FileSession(store, job);
    const continuation = await files.request(request, signal());
    if (continuation.action !== "save") throw Error("wrong result");
    assert.notEqual(
      continuation.attachment.id,
      first.attachment.id,
      "a fresh MCP scope may reuse the transport request number",
    );
    const db = new DatabaseSync(path);
    assert.equal(
      db.prepare("PRAGMA user_version").get()?.user_version,
      maxDatabaseVersion,
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
  } finally {
    await files?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
