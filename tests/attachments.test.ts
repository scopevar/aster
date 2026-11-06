import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectAttachment } from "../src/attachments/content.js";
import { materializeAttachments } from "../src/attachments/materialize.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

const command = (value: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command: value });
await test("attachments are scoped, immutable and sent atomically; cancellation fences late upload and cache preserves exact bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-attachment-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const created = store.execute(
      command({ type: "bot.create", name: "Files", description: "" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    assert.ok(created.id);
    const other = store.execute(
      command({ type: "conversation.create", botId: created.id }),
    ).conversationId;
    assert.ok(other);
    const input = { id: randomUUID(), conversationId, name: "notes.txt" };
    const bytes = Buffer.from("真实附件 " + randomUUID());
    const saved = store.files.registerAttachment(input, bytes);
    assert.equal(store.files.registerAttachment(input, bytes).id, saved.id);
    assert.throws(
      () => store.files.registerAttachment(input, Buffer.from("changed")),
      /不同内容/,
    );
    assert.throws(
      () => store.files.attachmentContent(other, saved.id),
      /不属于/,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "message.send",
            conversationId: other,
            text: "",
            attachmentIds: [saved.id],
          }),
        ),
      /不属于/,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "message.send",
            conversationId,
            text: "",
            attachmentIds: [saved.id, saved.id],
          }),
        ),
      /重复/,
    );
    assert.throws(
      () =>
        store.execute(
          command({ type: "message.send", conversationId, text: "" }),
        ),
      /请输入/,
    );
    const cancelled = { ...input, id: randomUUID() };
    store.execute(
      command({ type: "attachment.remove", conversationId, id: cancelled.id }),
    );
    assert.throws(
      () => store.files.registerAttachment(cancelled, bytes),
      /取消/,
    );
    const reopened = new Store(join(directory, "db.sqlite"));
    try {
      assert.equal(
        reopened.views
          .snapshot({})
          .conversations.find((c) => c.id === conversationId)
          ?.draftAttachments[0]?.name,
        "notes.txt",
      );
    } finally {
      reopened.close();
    }
    const send = command({
      type: "message.send",
      conversationId,
      text: "Read this",
      attachmentIds: [saved.id],
    });
    const run = store.execute(send);
    assert.deepEqual(store.execute(send), run);
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((c) => c.id === conversationId)?.draftAttachments
        .length,
      0,
    );
    assert.equal(
      store.views.snapshot({ conversationId }).messages[0]?.attachments[0]?.id,
      saved.id,
    );
    assert.throws(
      () =>
        store.execute(
          command({ type: "attachment.remove", conversationId, id: saved.id }),
        ),
      /尚未发送/,
    );
    const job = store.runs.claim();
    assert.ok(job);
    const root = join(directory, "workspaces"),
      workspace = join(root, job.botId);
    await mkdir(workspace, { recursive: true });
    const files = await materializeAttachments(
      store,
      root,
      workspace,
      job,
      new AbortController().signal,
    );
    const path = files[0]?.path;
    assert.ok(path);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(
      await materializeAttachments(
        store,
        root,
        workspace,
        job,
        new AbortController().signal,
      ),
      files,
    );
    await assert.rejects(
      materializeAttachments(store, root, workspace, job, AbortSignal.abort()),
      /abort/i,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("attachment content checks reject oversized, malformed and unsupported files", () => {
  assert.throws(
    () => inspectAttachment("large.txt", Buffer.alloc(25 * 1024 * 1024 + 1)),
    /25 MiB/,
  );
  assert.throws(
    () => inspectAttachment("binary.txt", Buffer.from([0, 255])),
    /UTF-8/,
  );
  assert.throws(
    () => inspectAttachment("broken.jpg", Buffer.from([255, 216, 0, 0, 0, 0])),
    /图片头/,
  );
  assert.throws(
    () =>
      inspectAttachment("book.docx", Buffer.from("not a supported document")),
    /Office 压缩结构/,
  );
  assert.throws(
    () => inspectAttachment("archive.zip", Buffer.from("PK archive")),
    /尚未接入/,
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNtsAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(inspectAttachment("pixel.png", png).mime, "image/png");
});

await test("attachment cache rejects linked Bot roots and linked attachment directories before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-attachment-scope-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const created = store.execute(
      command({ type: "bot.create", name: "Scope", description: "" }),
    );
    assert.ok(created.conversationId);
    const file = store.files.registerAttachment(
      {
        id: randomUUID(),
        conversationId: created.conversationId,
        name: "notes.txt",
      },
      Buffer.from("scope"),
    );
    store.execute(
      command({
        type: "message.send",
        conversationId: created.conversationId,
        text: "",
        attachmentIds: [file.id],
      }),
    );
    const state = store.views.snapshot({
      conversationId: created.conversationId,
    });
    assert.equal(state.conversations[0]?.preview, "附件：notes.txt");
    const messageId = state.messages[0]?.id;
    assert.ok(messageId);
    store.execute(
      command({
        type: "reply.save",
        conversationId: created.conversationId,
        messageId,
      }),
    );
    assert.equal(
      store.views.snapshot({}).conversations[0]?.replyTo?.text,
      "附件：notes.txt",
    );
    const job = store.runs.claim();
    assert.ok(job);
    const root = join(directory, "workspaces"),
      workspace = join(root, job.botId),
      other = join(root, "other");
    await mkdir(workspace, { recursive: true });
    await mkdir(other);
    await symlink(
      other,
      join(workspace, "attachments"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      materializeAttachments(
        store,
        root,
        workspace,
        job,
        new AbortController().signal,
      ),
      /不能指向/,
    );
    assert.deepEqual(await readdir(other), []);
    const linked = join(root, "linked");
    await symlink(
      other,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      materializeAttachments(
        store,
        root,
        linked,
        job,
        new AbortController().signal,
      ),
      /未授权/,
    );
    assert.deepEqual(await readdir(other), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
