import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { snapshotOf } from "./ipc-result.js";
import { newBot } from "./new-conversation.js";

test("real attachments persist, preview and reach Pi as actual files and native images", async () => {
  test.setTimeout(150000);
  const directory = await mkdtemp(join(tmpdir(), "aster-files-e2e-"));
  const worker = await startWorker(directory);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("附件验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const secret = `ATTACHMENT_${randomUUID()}`;
    const payload = `此文件的校验词是 ${secret}。`;
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "添加附件", exact: true }).click();
    await (
      await picker
    ).setFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(payload),
    });
    await expect(
      page.getByRole("button", { name: "预览 notes.txt", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "预览 notes.txt", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "notes.txt", exact: true }),
    ).toContainText(secret);
    await page.screenshot({
      path: test.info().outputPath("attachment-text-preview.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("请实际读取附件，告诉我里面的完整校验词，不要猜测。");
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item").first().click();
    await expect(
      page.getByRole("button", { name: "预览 notes.txt", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("请实际读取附件，告诉我里面的完整校验词，不要猜测。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(secret, { timeout: 90000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".message.user .attachment-chip")).toContainText(
      "notes.txt",
    );
    await expect(page.locator(".composer-wrap .attachment-chip")).toHaveCount(
      0,
    );
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 400, 240);
      ctx.fillStyle = "#ef2222";
      ctx.beginPath();
      ctx.arc(95, 120, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#2255ef";
      ctx.fillRect(235, 60, 120, 120);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    if (!png) throw new Error("PNG missing");
    await page.getByLabel("选择附件文件").setInputFiles({
      name: "shapes.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await page
      .getByRole("button", { name: "预览 shapes.png", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "shapes.png", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("attachment-image-preview.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("图片左右各是什么颜色和形状？用中文简短回答。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("红", { timeout: 90000 });
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("蓝");
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("圆");
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("方");
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("real-image-reply.png"),
      scale: "css",
    });
    await page.getByLabel("选择附件文件").setInputFiles({
      name: "remove.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("discard"),
    });
    await page
      .getByRole("button", { name: "移除 remove.txt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "预览 remove.txt", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("选择附件文件").setInputFiles({
      name: "unsupported.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PK archive fixture"),
    });
    await expect(page.locator(".upload-row.failed")).toContainText("尚未接入");
    await page
      .getByRole("button", { name: "取消上传 unsupported.zip", exact: true })
      .click();
    await expect(page.locator(".upload-row")).toHaveCount(0);
    // Correlate the actual input copy with persisted bytes, without bypassing the UI send path.
    const state = snapshotOf(
      await page.evaluate(() => window.aster.snapshot({})),
    );
    const bot = state.bots[0];
    if (!bot) throw new Error("Bot missing");
    const conversation = state.conversations[0];
    if (!conversation) throw new Error("Conversation missing");
    const history = snapshotOf(
      await page.evaluate(
        (conversationId) => window.aster.snapshot({ conversationId }),
        conversation.id,
      ),
    );
    const file = history.messages
      .flatMap((m) => m.attachments)
      .find((f) => f.name === "notes.txt");
    if (!file) throw new Error("Attachment missing");
    expect(
      await readFile(
        join(
          localWorkspaceDirectory(directory),
          "workspaces",
          bot.id,
          "attachments",
          `${file.id}.txt`,
        ),
        "utf8",
      ),
    ).toBe(payload);
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
