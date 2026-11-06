import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { ValidatedAvatar } from "../src/avatars/image.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import {
  clampCrop,
  cropRectangle,
} from "../src/ui/components/avatar/avatar-crop.js";
const command = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });

await test("avatar pixels are decoded; versioned identity, image bytes and reset persist atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-avatar-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const botId = store.execute(
      command({ type: "bot.create", name: "Avatar", description: "" }),
    ).id;
    assert.ok(botId);
    const before = store.views.snapshot({}).bots[0];
    assert.equal(before?.avatar.shape, "hexagon");
    const image = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#2255dd" },
    })
      .webp()
      .toBuffer();
    const remote = await sharp({
      create: { width: 480, height: 320, channels: 3, background: "#dd5522" },
    })
      .png()
      .toBuffer();
    const normalized = await ValidatedAvatar.fromImage(remote);
    const normalizedMeta = await sharp(normalized.bytes).metadata();
    assert.equal(normalizedMeta.format, "webp");
    assert.equal(normalizedMeta.width, 256);
    assert.equal(normalizedMeta.height, 256);
    await assert.rejects(
      ValidatedAvatar.decode(image.subarray(0, 24).toString("base64")),
      /完整/,
    );
    const oversized = await sharp({
      create: { width: 257, height: 256, channels: 3, background: "#2255dd" },
    })
      .webp()
      .toBuffer();
    await assert.rejects(
      ValidatedAvatar.decode(oversized.toString("base64")),
      /完整/,
    );
    const save = command({
      type: "bot.avatar.image",
      botId,
      revision: 0,
      data: image.toString("base64"),
    });
    assert.throws(() => store.execute(save), /完整解码/);
    const valid = await ValidatedAvatar.decode(image.toString("base64"));
    store.execute(save, valid);
    assert.deepEqual(store.execute(save, valid), {});
    assert.equal(store.views.snapshot({}).bots[0]?.avatar.revision, 1);
    assert.throws(
      () =>
        store.execute(
          command({
            type: "bot.avatar.character",
            botId,
            revision: 0,
            shape: "drop",
            color: "red",
          }),
        ),
      /已被更新/,
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      Buffer.from(
        store.avatarContent({ botId, hash: valid.hash }).data,
        "base64",
      ),
      image,
    );
    const other = store.execute(
      command({ type: "bot.create", name: "Other", description: "" }),
    ).id;
    assert.ok(other);
    assert.throws(
      () => store.avatarContent({ botId: other, hash: valid.hash }),
      /版本/,
    );
    store.execute(
      command({
        type: "bot.avatar.character",
        botId,
        revision: 1,
        shape: "drop",
        color: "red",
      }),
    );
    assert.throws(
      () => store.avatarContent({ botId, hash: valid.hash }),
      /版本/,
    );
    assert.deepEqual(
      store.views.snapshot({}).bots.find((b) => b.id === botId)?.avatar,
      { shape: "drop", color: "red", revision: 2, imageHash: null },
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("crop limits prevent blank pixels when dragging beyond an edge or zooming back out", () => {
  const image = { width: 400, height: 240 };
  const right = clampCrop(image, { x: 900, y: -500, zoom: 2 });
  assert.deepEqual(cropRectangle(image, right), { x: 280, y: 0, side: 120 });
  const out = clampCrop(image, { ...right, zoom: 1 });
  assert.deepEqual(cropRectangle(image, out), { x: 160, y: 0, side: 240 });
});
