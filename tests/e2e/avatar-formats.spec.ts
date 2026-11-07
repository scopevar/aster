import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { newBot } from "./new-conversation.js";

function bmp(width: number, height: number) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write("BM", 0);
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * stride + x * 3;
      bytes[offset] = 230;
      bytes[offset + 1] = 40;
      bytes[offset + 2] = 20;
    }
  return bytes;
}

function savedAvatar(directory: string) {
  const db = new DatabaseSync(
    join(localWorkspaceDirectory(directory), "aster.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    const raw = db
      .prepare("SELECT avatarJson FROM bots WHERE name='格式头像'")
      .get()?.avatarJson;
    if (typeof raw !== "string") throw Error("Bot identity missing");
    const image = db.prepare("SELECT data FROM bot_avatar_images").get()?.data;
    return {
      revision: Number(JSON.parse(raw).revision),
      image: image instanceof Uint8Array ? Buffer.from(image) : null,
    };
  } finally {
    db.close();
  }
}

test("GIF and BMP avatar sources decode in Electron, normalize to WebP and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-avatar-formats-"));
  let worker = await startWorker(directory);
  const env = Object.fromEntries([
    ...Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
    ["ASTER_DATA_DIR", directory],
  ]);
  let app = await electron.launch({ args: [resolve(".")], env });
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("格式头像");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "创建新 Bot" })).toHaveCount(
      0,
    );
    await page.locator(".conversation-title").click();
    await page
      .getByRole("button", { name: "编辑 Bot 头像", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "头像编辑器" });
    await editor.getByRole("tab", { name: "上传", exact: true }).click();
    await expect(editor.getByLabel("选择头像图片")).toHaveAttribute(
      "accept",
      /image\/gif/,
    );
    await expect(editor.getByLabel("选择头像图片")).toHaveAttribute(
      "accept",
      /\.bmp/,
    );

    const frames = Buffer.alloc(64 * 64 * 3 * 2);
    for (let index = 0; index < frames.length; index += 3) {
      const first = index < frames.length / 2;
      frames[index] = first ? 230 : 30;
      frames[index + 1] = first ? 40 : 220;
      frames[index + 2] = 40;
    }
    const gif = await sharp(frames, {
      raw: { width: 64, height: 128, channels: 3, pageHeight: 64 },
    })
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    const chooseGif = page.waitForEvent("filechooser");
    await editor.getByRole("button", { name: "选择本地图片" }).click();
    await (
      await chooseGif
    ).setFiles({ name: "first.gif", mimeType: "image/gif", buffer: gif });
    await expect(
      editor.getByRole("img", { name: /头像裁剪预览/ }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "设置头像", exact: true }).click();
    await expect.poll(() => savedAvatar(directory).revision).toBe(1);
    let saved = savedAvatar(directory).image;
    expect(saved).not.toBeNull();
    expect((await sharp(saved!).metadata()).format).toBe("webp");
    let pixels = await sharp(saved!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixels.info.width).toBe(256);
    expect(pixels.data[0]).toBeGreaterThan(160);
    expect(pixels.data[2]).toBeLessThan(80);

    await editor.getByRole("button", { name: "重新开始" }).click();
    const chooseBmp = page.waitForEvent("filechooser");
    await editor.getByRole("button", { name: "选择本地图片" }).click();
    await (
      await chooseBmp
    ).setFiles({
      name: "second.bmp",
      mimeType: "image/bmp",
      buffer: bmp(64, 64),
    });
    await expect(
      editor.getByRole("img", { name: /头像裁剪预览/ }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "设置头像", exact: true }).click();
    await expect.poll(() => savedAvatar(directory).revision).toBe(2);
    saved = savedAvatar(directory).image;
    expect(saved).not.toBeNull();
    pixels = await sharp(saved!).raw().toBuffer({ resolveWithObject: true });
    expect(pixels.data[0]).toBeLessThan(80);
    expect(pixels.data[2]).toBeGreaterThan(160);

    await editor.getByRole("button", { name: "重新开始" }).click();
    const chooseBroken = page.waitForEvent("filechooser");
    await editor.getByRole("button", { name: "选择本地图片" }).click();
    await (
      await chooseBroken
    ).setFiles({
      name: "broken.bmp",
      mimeType: "image/bmp",
      buffer: bmp(64, 64).subarray(0, 60),
    });
    await expect(editor.getByRole("alert")).toBeVisible();
    expect(savedAvatar(directory).revision).toBe(2);
    await page.keyboard.press("Escape");
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item", { hasText: "格式头像" }).click();
    await expect(page.locator(".conversation-title .avatar img")).toBeVisible();
    expect(savedAvatar(directory).revision).toBe(2);
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 200,
    });
  }
});
