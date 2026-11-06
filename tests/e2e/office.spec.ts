import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { sampleWord, sampleWorkbook } from "../helpers/office.js";
import { newBot } from "./new-conversation.js";

test("real Office UI previews safe Word content, selects spreadsheet ranges and reaches Pi with exact documents across restart", async ({}, info) => {
  test.setTimeout(300000);
  const directory = await mkdtemp(join(tmpdir(), "aster-office-e2e-"));
  let worker = await startWorker(directory);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  const wordToken = "WORD_" + randomUUID().slice(0, 8),
    imageToken = "IMG_" + randomUUID().slice(0, 8),
    sheetToken = "SHEET_" + randomUUID().slice(0, 8);
  const wordBytes = sampleWord(wordToken, imageToken),
    sheetBytes = sampleWorkbook(sheetToken, 300);
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("Office 验收");
    await page
      .getByLabel("说明", { exact: true })
      .fill(
        "文档内容必须使用 documents 工具实际读取，表格公式只报告文件保存的结果，不重算。图片须实际调用 word.image 查看。",
      );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const upload = async (name: string, bytes: Buffer) => {
      await page.getByRole("button", { name: "添加附件", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("menuitem", { name: "添加附件", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
      await expect(
        page.getByRole("button", { name: `预览 ${name}`, exact: true }),
      ).toBeVisible();
    };
    await upload("proof.docx", wordBytes);
    await page
      .getByRole("button", { name: "预览 proof.docx", exact: true })
      .click();
    let modal = page.getByRole("dialog", { name: "proof.docx", exact: true });
    await expect(
      modal.getByRole("article", { name: "Word 文档内容" }),
    ).toContainText(wordToken, { timeout: 30000 });
    await expect(
      modal.locator("strong").filter({ hasText: "中文文档" }),
    ).toBeVisible();
    await expect(
      modal.getByRole("cell", { name: "42", exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByRole("img", { name: "验收图形", exact: true }),
    ).toBeVisible();
    await expect(modal.locator('a[href^="javascript:"]')).toHaveCount(0);
    await modal.getByRole("button", { name: /文档读取说明/ }).click();
    await expect(modal.locator(".office-warnings")).toContainText("不安全");
    await page.screenshot({
      path: info.outputPath("word-preview.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "预览 proof.docx", exact: true }),
    ).toBeFocused();
    await upload("proof.xlsx", sheetBytes);
    await page
      .getByRole("button", { name: "预览 proof.xlsx", exact: true })
      .click();
    modal = page.getByRole("dialog", { name: "proof.xlsx", exact: true });
    await expect(
      modal.getByRole("gridcell", { name: "A2", exact: true }),
    ).toHaveText(sheetToken, { timeout: 30000 });
    await expect(
      modal.getByRole("gridcell", { name: "B2", exact: true }),
    ).toHaveText("0");
    await expect(
      modal.getByRole("gridcell", { name: "C2", exact: true }),
    ).toHaveText("42");
    await modal.getByRole("gridcell", { name: "C2", exact: true }).click();
    await expect(modal.locator(".sheet-value")).toHaveText("=SUM(B2,42)");
    await modal.getByRole("gridcell", { name: "A2", exact: true }).click();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await modal.getByRole("button", { name: "复制选区", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${sheetToken}\t0\t42`);
    await modal.getByRole("grid", { name: "数据", exact: true }).focus();
    await page.keyboard.press("Control+End");
    await expect(
      modal.getByRole("gridcell", { name: "B300", exact: true }),
    ).toHaveText("300", { timeout: 30000 });
    expect(await modal.getByRole("gridcell").count()).toBeLessThan(150);
    await page.keyboard.press("Control+Home");
    await expect(
      modal.getByRole("gridcell", { name: "A2", exact: true }),
    ).toHaveText(sheetToken);
    await page.screenshot({
      path: info.outputPath("table-preview.png"),
      scale: "css",
    });
    await modal.getByRole("tab", { name: "明细", exact: true }).click();
    await expect(
      modal.getByRole("gridcell", { name: "A2", exact: true }),
    ).toHaveText(sheetToken + "_SECOND", { timeout: 30000 });
    await modal.getByRole("tab", { name: "数据", exact: true }).click();
    await expect(
      modal.getByRole("gridcell", { name: "A2", exact: true }),
    ).toHaveText(sheetToken, { timeout: 30000 });
    await page.keyboard.press("Escape");
    await upload("broken.docx", Buffer.from([0x50, 0x4b, 3, 4, 0]));
    await page
      .getByRole("button", { name: "预览 broken.docx", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "broken.docx", exact: true })
        .getByRole("alert"),
    ).toContainText("无法解析", { timeout: 30000 });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "移除 broken.docx", exact: true })
      .click();
    await page
      .getByLabel("消息", { exact: true })
      .fill(
        "用 documents 实际读取两个附件。报告 DOCX 中完整 WORD_ 校验词；调用 word.image 查看图片，报告图内完整 IMG_ 校验词和图形颜色形状。读取 XLSX 数据表 A2:C2，报告完整校验词、B2 原值、C2 公式与文件保存结果，再读取明细表 A2。不要执行 Windows shell，不猜测内容。",
      );
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page
      .getByRole("navigation", { name: "会话" })
      .getByRole("button", { name: /Office 验收/ })
      .click();
    await expect(
      page.getByRole("button", { name: "预览 proof.docx", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "预览 proof.xlsx", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const answer = page.locator(".message.assistant .bubble").last();
    await expect(answer).toContainText(wordToken, { timeout: 150000 });
    await expect(answer).toContainText(imageToken);
    await expect(answer).toContainText(/蓝|blue/i);
    await expect(answer).toContainText(/方|square/i);
    await expect(answer).toContainText(sheetToken);
    await expect(answer).toContainText(sheetToken + "_SECOND");
    await expect(answer).toContainText("42");
    await expect(answer).toContainText("SUM(B2,42)");
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 30000 });
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      const calls = db
        .prepare("SELECT action,status FROM document_calls")
        .all();
      for (const action of ["word.text", "word.image", "table.range"])
        expect(calls).toContainEqual({ action, status: "completed" });
      for (const [name, bytes] of [
        ["proof.docx", wordBytes],
        ["proof.xlsx", sheetBytes],
      ] as const) {
        const saved = db
          .prepare("SELECT data FROM attachments WHERE name=?")
          .get(name)?.data;
        if (!(saved instanceof Uint8Array))
          throw Error("Attachment bytes missing");
        expect(Buffer.from(saved)).toEqual(bytes);
      }
    } finally {
      db.close();
    }
    await page.screenshot({
      path: info.outputPath("office-model-answer.png"),
      scale: "css",
    });
    await app.close();
    await worker.stop();
    worker = await startWorker(directory);
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page
      .getByRole("navigation", { name: "会话" })
      .getByRole("button", { name: /Office 验收/ })
      .click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(imageToken);
    await page
      .getByLabel("消息", { exact: true })
      .fill(
        "再次调用 documents 读取前一条消息的 XLSX 明细表 A2，只逐字输出这个单元格的完整值，不加前缀、标点或解释。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant .bubble").last()).toHaveText(
      sheetToken + "_SECOND",
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
