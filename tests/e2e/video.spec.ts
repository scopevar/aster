import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { sampleVideo } from "../helpers/video.js";
import { newBot } from "./new-conversation.js";

test("real video upload and player reach Pi as two time-specific images containing unseen random text", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-video-e2e-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-video-fixture-"));
  const first = `FIRST_${randomBytes(4).toString("hex")}`,
    second = `LAST_${randomBytes(4).toString("hex")}`;
  const { bytes } = await sampleVideo(outside, first, second);
  const worker = await startWorker(directory);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ASTER_DATA_DIR: directory }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await app.firstWindow();
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error("renderer", message.text().slice(0, 1000));
    });
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("视频画面验收");
    await page
      .getByLabel("说明", { exact: true })
      .fill(
        "使用 documents 的 video.info 与 video.frame 读取视频，不能用文件名猜测画面内容。",
      );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "添加附件", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "demonstration.mp4",
      mimeType: "video/mp4",
      buffer: bytes,
    });
    await page
      .getByRole("button", { name: "预览 demonstration.mp4", exact: true })
      .click();
    const modal = page.getByRole("dialog", {
      name: "demonstration.mp4",
      exact: true,
    });
    await expect
      .poll(() =>
        modal.locator("video").evaluate((el) =>
          el instanceof HTMLVideoElement
            ? {
                ready: el.readyState > 1,
                network: el.networkState,
                error: el.error?.message ?? null,
                canPlay: el.canPlayType("video/mp4"),
                source: el.currentSrc.slice(0, 12),
              }
            : { ready: false },
        ),
      )
      .toMatchObject({ ready: true });
    expect(
      await modal
        .locator("video")
        .evaluate((el) => (el instanceof HTMLVideoElement ? el.duration : 0)),
    ).toBe(4);
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill(
        "请实际读取附件视频的信息，以及 timeMs=500 和 timeMs=2500 的两帧。逐字抄写这两帧中的验证码，并按时间顺序给出两块色块的颜色。不使用 shell，不猜测内容。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(first, { timeout: 120000 });
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(second, { timeout: 120000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 15000 });
    for (const time of [500, 2500]) {
      const card = page.locator(".document-card.completed").filter({
        hasText: `已读取 ${time} 毫秒处的画面`,
      });
      await card.getByRole("button", { name: /读取视频画面/ }).click();
      await expect(
        card.getByRole("button", { name: /读取视频画面/ }),
      ).toContainText("读取视频画面");
    }
    await expect(
      page.getByText("已读取 500 毫秒处的画面", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("已读取 2500 毫秒处的画面", { exact: false }),
    ).toBeVisible();
    const answer = await page
      .locator(".message.assistant .bubble")
      .last()
      .innerText();
    expect(answer.indexOf(first)).toBeLessThan(answer.indexOf(second));
    expect(answer).toMatch(/红|red/i);
    expect(answer).toMatch(/蓝|blue/i);
    await page.screenshot({
      path: info.outputPath("real-video-reading.png"),
      scale: "css",
    });
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
