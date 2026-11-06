import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";

// The build artifacts are the boundary: native windows, the renderer and
// installers must receive the same transparent artwork, including small sizes.
await test("application surfaces share the transparent Aster artwork", async () => {
  const [application, avatar, linux, windows] = await Promise.all([
    readFile("dist/desktop/assets/aster-app.png"),
    readFile("dist/renderer/assets/aster-avatar.png"),
    readFile("build/icons/256x256.png"),
    readFile("dist/desktop/assets/aster.ico"),
  ]);
  assert.deepEqual(avatar, application);
  assert.deepEqual(linux, application);
  assert.equal(windows.readUInt16LE(0), 0);
  assert.equal(windows.readUInt16LE(2), 1);
  const count = windows.readUInt16LE(4);
  const representations = new Map<number, Buffer>();
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = windows[entry] || 256;
    const height = windows[entry + 1] || 256;
    assert.equal(height, width);
    const size = windows.readUInt32LE(entry + 8);
    const offset = windows.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + count * 16);
    assert.ok(offset + size <= windows.length);
    const image = windows.subarray(offset, offset + size);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.equal(metadata.hasAlpha, true);
    const alpha = await sharp(image).extractChannel("alpha").raw().toBuffer();
    let left = width,
      right = -1,
      top = height,
      bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if ((alpha[y * width + x] ?? 0) > 16) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    const visibleWidth = right - left + 1;
    assert.ok(
      visibleWidth >= width * 0.8 && visibleWidth <= width * 0.95,
      `${width}px icon artwork occupies only ${visibleWidth}px`,
    );
    assert.ok(Math.abs(left + right + 1 - width) <= 2);
    assert.ok(Math.abs(top + bottom + 1 - height) <= 2);
    representations.set(width, image);
  }
  assert.deepEqual(representations.get(256), application);
  for (const size of [16, 24, 32, 48, 64, 128, 256])
    assert.ok(representations.has(size), `Windows icon is missing ${size}px`);
  for (const [file, size] of [
    ["dist/desktop/assets/aster-tray.png", 16],
    ["dist/desktop/assets/aster-tray@2x.png", 32],
  ] as const) {
    const image = await readFile(file);
    assert.deepEqual(image, representations.get(size));
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    assert.equal(metadata.hasAlpha, true);
    const alpha = await sharp(image).extractChannel("alpha").stats();
    assert.equal(alpha.channels[0]?.min, 0);
    assert.ok((alpha.channels[0]?.max ?? 0) > 240);
  }
});
