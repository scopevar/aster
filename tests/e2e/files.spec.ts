import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { samplePdf } from "../helpers/pdf.js";
import { newBot } from "./new-conversation.js";

test("a real agent reads a granted directory and saves a downloadable file; revocation and output survive restart", async () => {
  test.setTimeout(240000);
  const directory = await mkdtemp(join(tmpdir(), "aster-real-files-"));
  const granted = join(directory, "selected-folder");
  await mkdir(granted);
  const proof = `ACTUAL_FILE_${randomUUID()}_中文`;
  await writeFile(join(granted, "source.txt"), proof);
  const pdfProof = `PDF_${randomUUID()}`;
  await writeFile(
    join(granted, "source.pdf"),
    samplePdf(pdfProof, "UNUSED_SCAN"),
  );
  const expected = `${proof}\n${pdfProof}`;
  let worker = await startWorker(directory);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("目录成果验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    // Only native picker selection is substituted; directory authorization and model calls are real.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, granted);
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("/授权目录");
    await page.getByRole("option", { name: /^授权目录 / }).click();
    await expect(page.getByLabel("已授权目录", { exact: true })).toContainText(
      granted,
    );
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill(
        "只使用当前 files MCP 工具，不使用 shell。先列出本会话目录授权，read 读取 source.txt 的真实 UTF-8 内容，再用 document 操作解析同目录 source.pdf 第一页的文字（内部 operation 是 text，page 是 1）。然后用 save 保存名为 proof.txt 的可下载成果：第一行逐字复制 source.txt，换行后第二行逐字复制 PDF 第一页的文字；末尾不要加换行、解释或代码围栏。完成后简短回复。不能只给文件路径。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "预览 proof.txt", exact: true }),
    ).toBeVisible({ timeout: 180000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 30000 });
    await page
      .getByRole("button", { name: "预览 proof.txt", exact: true })
      .click();
    const preview = page.getByRole("dialog", {
      name: "proof.txt",
      exact: true,
    });
    await expect(preview).toContainText(proof);
    const saved = join(directory, "downloaded.txt");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, saved);
    await preview
      .getByRole("button", { name: "保存附件", exact: true })
      .click();
    await expect
      .poll(async () => {
        try {
          return await readFile(saved, "utf8");
        } catch {
          return null;
        }
      })
      .toBe(expected);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: `撤销目录授权 ${granted}`, exact: true })
      .click();
    await expect(page.getByLabel("已授权目录", { exact: true })).toHaveCount(0);
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item").first().click();
    await expect(
      page.getByRole("button", { name: "预览 proof.txt", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("已授权目录", { exact: true })).toHaveCount(0);
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      expect(
        db.prepare("SELECT count(*) n FROM file_tool_receipts").get()?.n,
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) n FROM directory_grants").get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
