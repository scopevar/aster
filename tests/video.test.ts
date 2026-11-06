import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DocumentReader } from "../src/documents/reader.js";
import { DocumentSession } from "../src/documents/service.js";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { VideoReader } from "../src/video/reader.js";
import { sampleVideo } from "./helpers/video.js";
const signal = () => new AbortController().signal;
const command = (command: Command) => ({
  id: randomUUID(),
  command,
});

await test("real WebM decoder preserves held frames and missing components fail explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-webm-test-"));
  const reader = new VideoReader();
  try {
    const { bytes } = await sampleVideo(directory, "WEBM_A", "WEBM_B", "webm");
    for (const [timeMs, channel] of [
      [500, 0],
      [2500, 2],
    ] as const) {
      const frame = await reader.read(
        bytes,
        "capture.webm",
        { action: "video.frame", timeMs },
        signal(),
      );
      assert.equal(frame.action, "video.frame");
      assert.ok(frame.action === "video.frame");
      assert.equal(frame.selection, "last-frame-at-or-before");
      const pixel = await sharp(Buffer.from(frame.image, "base64"))
        .extract({ left: 20, top: 20, width: 1, height: 1 })
        .raw()
        .toBuffer();
      assert.ok(pixel[channel]! >= 250);
      assert.ok(pixel[channel === 0 ? 2 : 0]! <= 4);
    }
    const previous = process.env.ASTER_FFMPEG_DIR;
    let missing: VideoReader;
    try {
      process.env.ASTER_FFMPEG_DIR = join(directory, "missing-component");
      missing = new VideoReader();
    } finally {
      if (previous === undefined) delete process.env.ASTER_FFMPEG_DIR;
      else process.env.ASTER_FFMPEG_DIR = previous;
    }
    try {
      await assert.rejects(
        missing.read(bytes, "capture.webm", { action: "video.info" }, signal()),
        /无法启动视频组件/,
      );
    } finally {
      await missing.close();
    }
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group video access follows explicit delivery and rejects draft, private and future attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-group-video-"));
  const store = new Store(":memory:");
  try {
    const { bytes } = await sampleVideo(directory);
    const a = store.execute(
      command({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      command({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.id && a.conversationId && b.id);
    const group = store.execute(
      command({ type: "group.prepare", memberIds: [a.id, b.id] }),
    );
    assert.ok(group.conversationId);
    const upload = (conversationId: string) =>
      store.files.registerAttachment(
        { id: randomUUID(), conversationId, name: "scope.mp4" },
        bytes,
      );
    const received = upload(group.conversationId),
      draft = upload(group.conversationId),
      privateFile = upload(a.conversationId);
    store.execute(
      command({
        type: "group.start",
        conversationId: group.conversationId,
        memberIds: [a.id, b.id],
        text: "inspect shared video",
        attachmentIds: [received.id],
      }),
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    const future = upload(group.conversationId);
    store.execute(
      command({
        type: "message.send",
        conversationId: group.conversationId,
        recipientIds: [a.id],
        text: "later",
        attachmentIds: [future.id],
      }),
    );
    assert.deepEqual(
      store.documentOperations
        .documentList(turn)
        .documents.map((file) => file.id),
      [received.id],
    );
    assert.deepEqual(
      Buffer.from(
        store.documentOperations.documentContent(turn, received.id).data,
      ),
      bytes,
    );
    for (const file of [draft, privateFile, future])
      assert.throws(
        () => store.documentOperations.documentContent(turn, file.id),
        /未向当前运行/,
      );
    store.runs.finishGroupTurn(turn, "completed", null);
    assert.throws(
      () => store.documentOperations.documentContent(turn, received.id),
      /运行已经结束/,
    );
    const next = store.runs.nextGroupTurn(parent);
    assert.ok(next);
    assert.deepEqual(
      store.documentOperations
        .documentList(next)
        .documents.map((file) => file.id),
      [received.id],
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("real FFmpeg reads time-specific pixels, rejects malformed and out-of-range video, and drains cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-video-test-"));
  const reader = new VideoReader();
  try {
    const { bytes } = await sampleVideo(directory);
    const info = await reader.read(
      bytes,
      "clip.mp4",
      { action: "video.info" },
      signal(),
    );
    assert.deepEqual(info, {
      action: "video.info",
      width: 640,
      height: 360,
      durationMs: 4000,
      hasAudio: false,
    });
    for (const [timeMs, color] of [
      [0, [254, 0, 0]],
      [500, [254, 0, 0]],
      [2500, [0, 0, 254]],
    ] as const) {
      const frame = await reader.read(
        bytes,
        "clip.mp4",
        { action: "video.frame", timeMs },
        signal(),
      );
      assert.ok(frame.action === "video.frame");
      const pixel = await sharp(Buffer.from(frame.image, "base64"))
        .extract({ left: 20, top: 20, width: 1, height: 1 })
        .raw()
        .toBuffer();
      for (let channel = 0; channel < 3; channel++)
        assert.ok(Math.abs(pixel[channel]! - color[channel]!) <= 4);
    }
    await assert.rejects(
      reader.read(
        bytes,
        "clip.mp4",
        { action: "video.frame", timeMs: 4000 },
        signal(),
      ),
      /时长内/,
    );
    await assert.rejects(
      reader.read(
        Buffer.from("broken"),
        "clip.mp4",
        { action: "video.info" },
        signal(),
      ),
      /无法解码/,
    );
    const a = new AbortController(),
      b = new AbortController();
    const first = reader.read(
      bytes,
      "clip.mp4",
      { action: "video.frame", timeMs: 0 },
      a.signal,
    );
    const second = reader.read(
      bytes,
      "clip.mp4",
      { action: "video.frame", timeMs: 0 },
      b.signal,
    );
    assert.throws(
      () => reader.read(bytes, "clip.mp4", { action: "video.info" }, signal()),
      /通道已满/,
    );
    const cancelled = Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
    a.abort();
    b.abort();
    await cancelled;
    assert.deepEqual(
      await reader.read(bytes, "clip.mp4", { action: "video.info" }, signal()),
      info,
    );
    await reader.close();
    assert.throws(
      () => reader.read(bytes, "clip.mp4", { action: "video.info" }, signal()),
      { name: "AbortError" },
    );
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("video document reads preserve delivered scope and receipts, and a cancelled run cannot read old media", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-video-scope-"));
  const store = new Store(":memory:");
  const reader = new DocumentReader(
    new URL("../dist/documents/office-worker.js", import.meta.url),
  );
  let session: DocumentSession | undefined;
  try {
    const { bytes } = await sampleVideo(directory);
    const bot = store.execute(
      command({ type: "bot.create", name: "Video", description: "" }),
    );
    assert.ok(bot.conversationId);
    const conversationId = bot.conversationId;
    const file = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "clip.mp4" },
      bytes,
    );
    const draft = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "draft.mp4" },
      bytes,
    );
    store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "inspect video",
        attachmentIds: [file.id],
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    session = new DocumentSession(store, reader, job);
    const request = {
      callId: "first",
      operation: { action: "video.info", id: file.id },
    };
    const info = await session.request(request, signal());
    assert.equal(info.action, "video.info");
    assert.deepEqual(await session.request(request, signal()), info);
    const listing = store.documentOperations.documentList(job);
    assert.deepEqual(
      listing.documents.map((file) => file.id),
      [file.id],
    );
    assert.throws(
      () => store.documentOperations.documentContent(job, draft.id),
      /未向当前运行明确共享/,
    );
    store.runs.finish(job.id, "cancelled", null);
    assert.throws(
      () => store.documentOperations.documentContent(job, file.id),
      /运行已经结束/,
    );
  } finally {
    await session?.close();
    await reader.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
