import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { openBotAction } from "./bot-actions.js";
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

function storedCover(directory: string) {
  const db = new DatabaseSync(
    join(localWorkspaceDirectory(directory), "aster.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    const raw = db
      .prepare("SELECT payloadJson FROM template_drafts")
      .get()?.payloadJson;
    if (typeof raw !== "string") return null;
    const image = JSON.parse(raw).avatar?.image;
    if (typeof image !== "string") return null;
    return Buffer.from(image, "base64");
  } finally {
    db.close();
  }
}

test("GIF and BMP template covers decode in Electron, save as WebP and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-template-cover-"));
  let worker = await startWorker(directory);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] => item[1] !== undefined,
    ),
  );
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("封面格式");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await page.locator(".conversation-title").click();
    await openBotAction(page, "本地模板");
    const local = page.getByRole("dialog", { name: "本地模板", exact: true });
    await local.getByLabel("包含技能", { exact: true }).uncheck();
    await local
      .getByRole("button", { name: "创建本地模板", exact: true })
      .click();
    await local.getByLabel("模板名称", { exact: true }).fill("封面草稿");
    await expect(local.getByLabel("模板图片文件")).toHaveAttribute(
      "accept",
      /image\/gif/,
    );
    await expect(local.getByLabel("模板图片文件")).toHaveAttribute(
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
    await local
      .getByRole("button", { name: "上传模板图片", exact: true })
      .click();
    await (
      await chooseGif
    ).setFiles({ name: "cover.gif", mimeType: "image/gif", buffer: gif });
    await expect(
      local.getByRole("img", { name: "模板图片裁剪预览", exact: true }),
    ).toBeVisible();
    await local
      .getByRole("button", { name: "应用裁剪图片", exact: true })
      .click();
    await expect(
      local.getByRole("img", { name: "模板头像", exact: true }),
    ).toBeVisible();
    await local.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect
      .poll(() => storedCover(directory), { timeout: 15000 })
      .not.toBeNull();
    let saved = storedCover(directory);
    expect(saved).not.toBeNull();
    expect((await sharp(saved!).metadata()).format).toBe("webp");
    let pixels = await sharp(saved!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixels.info.width).toBe(256);
    expect(pixels.info.height).toBe(256);
    expect(pixels.data[0]).toBeGreaterThan(160);
    expect(pixels.data[1]).toBeLessThan(80);
    expect(pixels.data[2]).toBeLessThan(80);

    const chooseBmp = page.waitForEvent("filechooser");
    await local
      .getByRole("button", { name: "上传模板图片", exact: true })
      .click();
    await (
      await chooseBmp
    ).setFiles({
      name: "cover.bmp",
      mimeType: "image/bmp",
      buffer: bmp(64, 64),
    });
    await expect(
      local.getByRole("img", { name: "模板图片裁剪预览", exact: true }),
    ).toBeVisible();
    await local
      .getByRole("button", { name: "应用裁剪图片", exact: true })
      .click();
    await local.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect
      .poll(async () => {
        const next = storedCover(directory);
        if (!next || !saved || next.equals(saved)) return false;
        const decoded = await sharp(next).raw().toBuffer();
        const red = decoded[0];
        const blue = decoded[2];
        return (
          red !== undefined && blue !== undefined && red < 80 && blue > 160
        );
      })
      .toBe(true);
    saved = storedCover(directory);
    pixels = await sharp(saved!).raw().toBuffer({ resolveWithObject: true });
    expect(pixels.data[0]).toBeLessThan(80);
    expect(pixels.data[2]).toBeGreaterThan(160);

    const chooseBroken = page.waitForEvent("filechooser");
    await local
      .getByRole("button", { name: "上传模板图片", exact: true })
      .click();
    await (
      await chooseBroken
    ).setFiles({
      name: "broken.bmp",
      mimeType: "image/bmp",
      buffer: bmp(64, 64).subarray(0, 60),
    });
    await expect(local.getByRole("alert")).toBeVisible();
    expect(storedCover(directory)?.equals(saved!)).toBe(true);

    await page.keyboard.press("Escape");
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item", { hasText: "封面格式" }).click();
    await page.locator(".conversation-title").click();
    await openBotAction(page, "本地模板");
    const reopened = page.getByRole("dialog", {
      name: "本地模板",
      exact: true,
    });
    await reopened.getByRole("button", { name: /封面草稿/ }).click();
    await expect(
      reopened.getByRole("img", { name: "模板头像", exact: true }),
    ).toBeVisible();
    const persisted = storedCover(directory);
    expect(persisted?.equals(saved!)).toBe(true);
    const again = await sharp(persisted!).raw().toBuffer();
    expect(again[0]).toBeLessThan(80);
    expect(again[2]).toBeGreaterThan(160);
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
