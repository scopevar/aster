import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { samplePdf } from "../helpers/pdf.js";
import { newBot } from "./new-conversation.js";

test("real PDF upload previews selectable text and scanned pages, persists through restart and reaches actual Pi document tools", async ({}, info) => {
  test.setTimeout(240000);
  const directory = await mkdtemp(join(tmpdir(), "aster-pdf-e2e-"));
  let worker = await startWorker(directory);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  const proof = "PDF_" + randomUUID().replaceAll("-", "").slice(0, 12),
    scan = "SCAN_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const bytes = samplePdf(proof, scan);
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("PDF 验收");
    await page
      .getByLabel("说明", { exact: true })
      .fill(
        "读取 PDF 时使用 documents 工具；扫描页实际渲染后查看，不猜测内容。未提供的文件不要推断。",
      );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const upload = async (name: string, buffer: Buffer) => {
      await page.getByRole("button", { name: "添加附件", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("menuitem", { name: "添加附件", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({ name, mimeType: "application/pdf", buffer });
      await expect(
        page.getByRole("button", { name: `预览 ${name}`, exact: true }),
      ).toBeVisible();
    };
    await upload("two-pages.pdf", bytes);
    const fontsBefore = await page.evaluate(() => document.fonts.size);
    await page
      .getByRole("button", { name: "预览 two-pages.pdf", exact: true })
      .click();
    const modal = page.getByRole("dialog", {
      name: "two-pages.pdf",
      exact: true,
    });
    await expect(modal.locator(".pdf-page-status")).toHaveCount(0, {
      timeout: 30000,
    });
    await expect(modal.locator(".textLayer")).toContainText([proof, ""]);
    await expect(modal.getByLabel("PDF 页码", { exact: true })).toHaveText(
      "1 / 2",
    );
    // Check the actual rendered canvas, not a placeholder or source fixture screenshot.
    const pixel = await modal
      .locator("canvas")
      .first()
      .evaluate((canvas) => {
        const node = canvas as HTMLCanvasElement;
        return [
          ...node
            .getContext("2d")!
            .getImageData(
              Math.floor(node.width * 0.2),
              Math.floor(node.height * 0.7),
              1,
              1,
            ).data,
        ];
      });
    expect(pixel).toEqual([51, 128, 204, 255]);
    const word = modal.locator(".textLayer span").filter({ hasText: proof });
    const bounds = await word.boundingBox();
    expect(bounds).toBeTruthy();
    if (!bounds) throw Error("PDF text has no selectable bounds");
    await page.mouse.move(bounds.x - 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width + 1,
      bounds.y + bounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      proof,
    );
    await page.screenshot({
      path: info.outputPath("pdf-text.png"),
      scale: "css",
    });
    await modal.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(modal.getByLabel("PDF 页码", { exact: true })).toHaveText(
      "2 / 2",
    );
    await page.screenshot({
      path: info.outputPath("pdf-scan.png"),
      scale: "css",
    });
    await modal.getByRole("button", { name: "放大 PDF", exact: true }).click();
    await modal.getByRole("button", { name: "放大 PDF", exact: true }).click();
    await modal.getByRole("button", { name: "缩小 PDF", exact: true }).click();
    await modal
      .getByRole("button", { name: "适应 PDF 宽度", exact: true })
      .click();
    await expect(modal.locator('[role="alert"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.workers().length).toBe(0);
    await expect
      .poll(() => page.evaluate(() => document.fonts.size))
      .toBe(fontsBefore);
    await expect(
      page.getByRole("button", { name: "预览 two-pages.pdf", exact: true }),
    ).toBeFocused();
    // Malformed PDFs retain their source and show parse failure; closing and reopening never hangs.
    await upload("broken.pdf", Buffer.from("%PDF-1.7 broken"));
    await page
      .getByRole("button", { name: "预览 broken.pdf", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "broken.pdf", exact: true })
        .getByRole("alert"),
    ).toContainText("无法打开 PDF", { timeout: 30000 });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "移除 broken.pdf", exact: true })
      .click();
    await page
      .getByLabel("消息", { exact: true })
      .fill(
        "请实际读取附件：用 documents 读取第一页文字，渲染第二页并查看图片。回复两页各自的完整校验词，以及第二页图形的颜色和形状。不要读取 Windows 文件或调用其他工具。",
      );
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page
      .getByRole("navigation", { name: "会话" })
      .getByRole("button", { name: /PDF 验收/ })
      .click();
    await expect(
      page.getByRole("button", { name: "预览 two-pages.pdf", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const answer = page.locator(".message.assistant .bubble").last();
    await expect(answer).toContainText(proof, { timeout: 120000 });
    await expect(answer).toContainText(scan);
    await expect(answer).toContainText(/蓝|blue/i);
    await expect(answer).toContainText(/三角|triangle/i);
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 60000 });
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      const actions = db
        .prepare("SELECT action,status FROM document_calls")
        .all();
      expect(actions).toContainEqual({ action: "text", status: "completed" });
      expect(actions).toContainEqual({ action: "render", status: "completed" });
      expect(
        Buffer.from(
          db
            .prepare("SELECT data FROM attachments WHERE name='two-pages.pdf'")
            .get()!.data as Uint8Array,
        ),
      ).toEqual(bytes);
    } finally {
      db.close();
    }
    await page.screenshot({
      path: info.outputPath("pdf-model-answer.png"),
      scale: "css",
    });
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page
      .getByRole("navigation", { name: "会话" })
      .getByRole("button", { name: /PDF 验收/ })
      .click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(scan);
    await expect(page.locator(".document-card.completed")).not.toHaveCount(0);
    await page
      .getByLabel("消息", { exact: true })
      .fill(
        "继续用 documents 重新读取上一条消息中 PDF 的第一页，仅回复文件内的完整校验词，不加标点或说明。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant .bubble").last()).toHaveText(
      proof,
      { timeout: 90000 },
    );
  } catch (error) {
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      await backup(db, info.outputPath("isolated-failure.sqlite"));
    } finally {
      db.close();
    }
    throw error;
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
