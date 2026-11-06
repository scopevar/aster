import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect } from "../helpers/desktop-test.js";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readWorker } from "../../src/worker/client.js";
import { nudgeWorker } from "../helpers/worker-snapshot.js";
import { newBot } from "./new-conversation.js";
import { openDesktop } from "../helpers/local-desktop.js";

test("message math and isolated SVG export work without a model reply", async ({
  desktop,
}) => {
  const directory = desktop.directory;
  const app = await desktop.launch({});
  const applicationOutput = join(
    dirname(await app.evaluate(({ app }) => app.getPath("exe"))),
    `aster-export-${randomUUID()}.svg`,
  );
  try {
    const page = await openDesktop(app);
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("图表导出");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toBeVisible();
    const ids = await page.evaluate(async () => {
      const result = await window.aster.snapshot({});
      if (!result.success) throw new Error(result.error.message);
      if (!result.data.changed) throw new Error("缺少完整快照");
      const snap = result.data.snapshot;
      const bot = snap.bots.find((item) => item.name === "图表导出");
      const conversation = snap.conversations.find(
        (item) => item.botId === bot?.id,
      );
      return { botId: bot?.id ?? "", conversationId: conversation?.id ?? "" };
    });
    expect(ids.botId).not.toBe("");
    expect(ids.conversationId).not.toBe("");
    const source = [
      "公式 $x^2$。",
      "```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```",
    ].join("\n\n");
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
    );
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("BEGIN IMMEDIATE");
      const runId = randomUUID();
      db.prepare(
        "INSERT INTO runs(id,botId,conversationId,status,createdAt) VALUES(?,?,?,'completed',?)",
      ).run(runId, ids.botId, ids.conversationId, Date.now());
      db.prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,consumed) VALUES(?,?,?,'user',?,?,?,1)",
      ).run(
        randomUUID(),
        ids.botId,
        ids.conversationId,
        source,
        Date.now(),
        runId,
      );
      db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await nudgeWorker(await readWorker(directory), ids.conversationId);
    const message = page.locator(".message.user").first();
    await expect(message.locator(".katex")).toBeVisible();
    await expect(
      message.getByRole("button", { name: "查看图表", exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await message
      .getByRole("button", { name: "查看图表", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "图表", exact: true });
    const frame = page.frameLocator('iframe[title="隔离图表"]');
    await expect(frame.locator("svg")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "导出 SVG", exact: true }),
    ).toBeEnabled();
    const drawn = await page
      .frames()
      .find((value) => value.url().endsWith("diagram-frame.html"))
      ?.evaluate(() => document.querySelector("svg")?.outerHTML ?? "");
    await test.info().attach("drawn.svg", {
      body: drawn ?? "",
      contentType: "image/svg+xml",
    });
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
    await expect(
      dialog.getByText("未导出图表。", { exact: true }),
    ).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath,
      });
    }, applicationOutput);
    await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("已安装程序目录");
    const notes = join(directory, "notes.txt");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, notes);
    await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("只能保存为 .svg");
    const folder = join(directory, "folder.svg");
    await mkdir(folder);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, folder);
    await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("链接或目录");
    const output = join(directory, "chart.svg");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
    await expect(
      dialog.getByText("已导出：chart.svg", { exact: true }),
    ).toBeVisible();
    const saved = await readFile(output, "utf8");
    expect(saved.startsWith("<svg")).toBe(true);
    expect(saved.endsWith("</svg>")).toBe(true);
    expect(saved).toContain("完成");
    expect(saved.toLowerCase()).not.toContain("<script");
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("svg")].some((node) =>
          node.textContent?.includes("完成"),
        ),
      ),
    ).toBe(false);
  } finally {
    await rm(applicationOutput, { force: true });
  }
});
