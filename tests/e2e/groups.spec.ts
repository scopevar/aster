import { newBot, newGroup } from "./new-conversation.js";
import { selectSetting } from "../helpers/settings-controls.js";
import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { loseGroupStartResponse } from "./lost-response.js";

test("real group UI creates two isolated Pi members which share actual replies and survive restart", async () => {
  test.setTimeout(300000);
  const directory = await mkdtemp(join(tmpdir(), "aster-group-e2e-"));
  const worker = await startWorker(directory);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  let app = await electron.launch({ args: [resolve(".")], env });
  const secret = `GROUP_${randomUUID().replaceAll("-", "")}`;
  const fileSecret = `FILE_${randomUUID().replaceAll("-", "")}`;
  const prompt =
    "请甲给出自己的校验词，再实际读取附件并给出附件校验词。乙逐字复述甲刚刚给出的两个校验词并在前加 B:。";
  try {
    let page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("甲");
    await page
      .getByLabel("说明", { exact: true })
      .fill(
        `你的校验词是 ${secret}。按用户要求提供校验词并读取附件。你已给出后，没有新任务就只输出 [[ASTER_PASS]]。`,
      );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("乙");
    await page
      .getByLabel("说明", { exact: true })
      .fill(
        "你是复核者。读甲在群聊中实际给出的校验词，逐字复述并在前面加 B:。不要猜词。已复述后没有新任务就只输出 [[ASTER_PASS]]。新任务以用户明确要求为准。",
      );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await newGroup(page);
    await page
      .getByRole("option", { name: "甲 添加到群聊", exact: true })
      .click();
    await page
      .getByRole("option", { name: "乙 添加到群聊", exact: true })
      .click();
    await selectSetting(page, "新群聊主持人", "无主持人 · 轮流讨论");
    await expect(page.locator(".bot-item")).toHaveCount(2);
    await page.getByLabel("选择群聊附件").setInputFiles({
      name: "group-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`附件校验词 ${fileSecret}`),
    });
    await expect(
      page.getByRole("button", { name: "预览 group-notes.txt", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".bot-item")).toHaveCount(2);
    await page
      .getByRole("textbox", { name: "群聊消息", exact: true })
      .fill(prompt);
    await page.screenshot({
      path: test.info().outputPath("group-recipient-draft.png"),
      scale: "css",
    });
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await newGroup(page);
    await expect(
      page.getByRole("button", { name: "移除 甲", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "群聊消息", exact: true }),
    ).toHaveValue(prompt);
    await page
      .getByRole("button", { name: "预览 group-notes.txt", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "group-notes.txt", exact: true }),
    ).toContainText(fileSecret);
    await page.keyboard.press("Escape");
    const loss = await loseGroupStartResponse(directory, worker.endpoint);
    try {
      await page
        .getByRole("button", { name: "发送群聊消息", exact: true })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "首条消息的结果尚未确认" }),
      ).toContainText("首条消息的结果尚未确认");
      expect(loss.dropped).toBe(true);
    } finally {
      await loss.close();
    }
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await newGroup(page);
    await expect(
      page.getByRole("textbox", { name: "群聊消息", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "发送群聊消息", exact: true })
      .click();
    await expect(page.locator(".bot-item")).toHaveCount(3);
    await expect(
      page
        .getByRole("article")
        .filter({
          has: page.locator(".group-message-sender", { hasText: "甲" }),
        })
        .filter({ hasText: secret })
        .first(),
    ).toContainText(secret, { timeout: 120000 });
    await expect(
      page
        .getByRole("article")
        .filter({
          has: page.locator(".group-message-sender", { hasText: "乙" }),
        })
        .filter({ hasText: secret })
        .first(),
    ).toContainText(secret, { timeout: 120000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 120000 });
    await expect(page.locator(".messages")).not.toContainText("[[ASTER_PASS]]");
    await expect(
      page
        .getByRole("article")
        .filter({
          has: page.locator(".group-message-sender", { hasText: "甲" }),
        })
        .filter({ hasText: fileSecret })
        .first(),
    ).toContainText(fileSecret);
    await expect(
      page
        .getByRole("article")
        .filter({
          has: page.locator(".group-message-sender", { hasText: "乙" }),
        })
        .filter({ hasText: fileSecret })
        .first(),
    ).toContainText(fileSecret);
    await page.screenshot({
      path: test.info().outputPath("real-group-replies.png"),
      scale: "css",
    });
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      const rows = db
        .prepare("SELECT threadId FROM group_members ORDER BY position")
        .all();
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (r) => typeof r.threadId === "string" && r.threadId.length > 0,
        ),
      ).toBe(true);
      expect(new Set(rows.map((r) => r.threadId)).size).toBe(2);
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM group_turns WHERE status IN('running','queued')",
          )
          .get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
    await expect(
      page.getByRole("button", { name: "模板操作", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "发起语音聊天（尚未可用）",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "开始语音输入（尚未可用）",
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(page.locator(".group-reply-avatar")).not.toHaveCount(0);
    await page.getByRole("button", { name: "群聊详情", exact: true }).click();
    await expect(
      page.getByRole("complementary", { name: "群聊详情" }),
    ).toContainText("甲");
    await page.screenshot({
      path: test.info().outputPath("group-overview.png"),
      scale: "css",
    });
    await page.getByRole("button", { name: "Bot 设置", exact: true }).click();
    await page.getByLabel("群组名称", { exact: true }).fill("协作验收");
    await page.getByRole("button", { name: "保存群设置", exact: true }).click();
    await expect(page.locator(".conversation-title")).toContainText("协作验收");
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item", { hasText: "协作验收" }).click();
    await expect(page.locator(".message.assistant")).toContainText([
      secret,
      secret,
    ]);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("@");
    await expect(page.getByRole("listbox", { name: "提及" })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("group-mention-menu.png"),
      scale: "css",
    });
    await page.getByRole("option", { name: "乙 Bot", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "取消提及 乙" }),
    ).toBeVisible();
    const groupInput = page.getByRole("textbox", { name: "消息", exact: true });
    await groupInput.fill("尚未发送 /成员");
    await groupInput.press("Enter");
    await expect(page.locator(".group-members")).toBeVisible();
    await expect(page.locator(".group-members button").first()).toBeFocused();
    await expect(groupInput).toHaveValue("尚未发送 ");
    await expect(
      page.getByRole("button", { name: "取消提及 乙" }),
    ).toBeVisible();
    await groupInput.fill("尚未发送 /聊天设置");
    await groupInput.press("Enter");
    await expect(page.getByLabel("群组名称", { exact: true })).toBeFocused();
    await expect(groupInput).toHaveValue("尚未发送 ");
    await groupInput.fill("尚未发送 /");
    await page.screenshot({
      path: test.info().outputPath("group-composer-actions.png"),
      scale: "css",
    });
    await groupInput.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("新任务：只输出 DIRECT: 后接甲的完整校验词。");
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    page = await app.firstWindow();
    await page.locator(".bot-item", { hasText: "协作验收" }).click();
    await expect(
      page.getByRole("button", { name: "取消提及 乙" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText(new RegExp(`DIRECT:\\s*${secret}`), { timeout: 120000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 120000 });
    const inspect = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      const last = inspect
        .prepare("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1")
        .get();
      if (typeof last?.id !== "string") throw Error("Missing directed run");
      const names = inspect
        .prepare(
          "SELECT b.name FROM group_turns t JOIN bots b ON b.id=t.botId WHERE t.runId=?",
        )
        .all(last.id);
      expect(names.map((r) => r.name)).toEqual(["乙", "乙"]);
      await page
        .getByRole("textbox", { name: "消息", exact: true })
        .fill("新任务：逐项详细解释一百种常用算法，按编号连续写，不要省略。");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect
        .poll(
          () =>
            inspect
              .prepare("SELECT turnId FROM runs ORDER BY rowid DESC LIMIT 1")
              .get()?.turnId,
          { timeout: 90000 },
        )
        .toBeTruthy();
      await expect(page.locator(".processing-reaction")).toHaveCount(1);
      await page.screenshot({
        path: test.info().outputPath("group-processing.png"),
        scale: "css",
      });
      await page.getByRole("button", { name: "停止回复", exact: true }).click();
      await expect
        .poll(
          () =>
            inspect
              .prepare("SELECT status FROM runs ORDER BY rowid DESC LIMIT 1")
              .get()?.status,
          { timeout: 30000 },
        )
        .toBe("cancelled");
      const turns = inspect
        .prepare(
          "SELECT status FROM group_turns WHERE runId=(SELECT id FROM runs ORDER BY rowid DESC LIMIT 1)",
        )
        .all();
      expect(turns.map((r) => r.status)).toEqual([
        "cancelled",
        "cancelled",
        "cancelled",
        "cancelled",
      ]);
      await expect(
        page.locator(".message.user").last().locator(".run-state"),
      ).toContainText("已取消");
      await expect(
        page.getByRole("button", { name: "停止回复", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".processing-reaction")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("group-cancelled.png"),
        scale: "css",
      });
      await page
        .getByRole("textbox", { name: "消息", exact: true })
        .fill("保留群聊草稿");
      await page.locator(".group-reply-avatar").last().click();
      await expect(page.locator(".conversation-title")).not.toContainText(
        "协作验收",
      );
      await expect(
        page.getByRole("button", { name: "模板操作", exact: true }),
      ).toBeVisible();
      await page.locator(".bot-item", { hasText: "协作验收" }).click();
      await expect(
        page.getByRole("textbox", { name: "消息", exact: true }),
      ).toHaveValue("保留群聊草稿");
    } finally {
      inspect.close();
    }
  } catch (error) {
    const db = new DatabaseSync(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      await backup(db, test.info().outputPath("isolated-failure.sqlite"));
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
      maxRetries: 15,
      retryDelay: 200,
    });
  }
});
