import { newBot, openStartConversation } from "./new-conversation.js";
import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { endpointSchema } from "../../src/platform/endpoint.js";
import { workerSnapshot } from "../helpers/worker-snapshot.js";
import {
  ensureDaemon,
  stopDaemon,
  daemonStatus,
} from "../../src/daemon/lifecycle.js";

test("real desktop + Pi: create, stream, resume, react, persist drafts and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.ASTER_DATA_DIR = directory;
  await ensureDaemon(directory, {
    executable: process.execPath,
    script: resolve("node_modules/@aster/cli/dist/cli/main.js"),
  });
  let app = await electron.launch({
    args: [resolve(".")],
    env,
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator(".sidebar")
        .getByRole("button", { name: "添加", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      scale: "css",
      path: test.info().outputPath("new-chat.png"),
    });
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("验收 Bot");
    await page
      .getByLabel("说明", { exact: true })
      .fill("Respond briefly. Do not use tools.");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("请记住验证码 Cedar47。这次只回复 Cedar47。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("Cedar47", { timeout: 90000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 10000 });
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("我刚才的验证码是什么？只回答验证码。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.assistant .bubble")).toHaveCount(2, {
      timeout: 90000,
    });
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("Cedar47", { timeout: 90000 });
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0, { timeout: 10000 });
    const last = page.locator(".message.assistant").last();
    await last.hover();
    await last.locator(".message-body").click({ button: "right" });
    await page.getByRole("button", { name: "回应 👍", exact: true }).click();
    await expect(
      last.getByRole("button", { name: "👍 1", exact: true }),
    ).toBeVisible();
    await last.locator(".message-body").click({ button: "right" });
    await page.keyboard.press("Home");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("button", { name: "更多表情", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "更多表情", exact: true });
    await expect(
      picker.getByRole("textbox", { name: "搜索表情符号" }),
    ).toBeFocused();
    await expect(picker).toBeInViewport({ ratio: 1 });
    await picker
      .getByRole("textbox", { name: "搜索表情符号" })
      .dispatchEvent("keydown", { key: "Escape", isComposing: true });
    await expect(picker).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("emoji-full.png"),
      scale: "css",
    });
    await picker.getByRole("textbox", { name: "搜索表情符号" }).fill("火箭");
    await picker
      .getByRole("textbox", { name: "搜索表情符号" })
      .press("ArrowDown");
    // “火箭” also matches astronaut tags; ArrowDown selects the first visible result.
    await expect(picker.locator("button[data-emoji]").first()).toBeFocused();
    await page.screenshot({
      scale: "css",
      path: test.info().outputPath("emoji-search.png"),
    });
    await picker.getByRole("button", { name: "回应 🚀", exact: true }).click();
    await expect(
      last.getByRole("button", { name: "🚀 1", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("重启后保留的草稿");
    await expect
      .poll(async () => {
        const endpoint = endpointSchema.parse(
          JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")),
        );
        const response = await fetch(
          `http://127.0.0.1:${endpoint.port}/snapshot`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${endpoint.token}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          },
        );
        const body: unknown = await response.json();
        return JSON.stringify(body);
      })
      .toContain("重启后保留的草稿");
    await page.screenshot({
      scale: "css",
      path: test.info().outputPath("real-chat.png"),
    });
    await writeFile(
      test.info().outputPath("visual-environment.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          clientWidth: innerWidth,
          clientHeight: innerHeight,
          devicePixelRatio,
          font: getComputedStyle(document.body).fontFamily,
        })),
        null,
        2,
      ),
    );
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    const reopened = await app.firstWindow();
    await reopened
      .getByRole("button", { name: /验收 Bot/ })
      .first()
      .click();
    await expect(
      reopened.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("重启后保留的草稿");
    await expect(
      reopened.locator(".message.assistant .bubble").last(),
    ).toContainText("Cedar47");
    await expect(
      reopened.getByRole("button", { name: "👍 1", exact: true }),
    ).toBeVisible();
    const restored = reopened.locator(".message.assistant").last();
    await expect(
      restored.getByRole("button", { name: "🚀 1", exact: true }),
    ).toBeVisible();
    await restored.hover();
    await restored.locator(".message-body").click({ button: "right" });
    await reopened
      .getByRole("button", { name: "更多表情", exact: true })
      .click();
    await expect(
      reopened
        .getByRole("region", { name: "最近使用" })
        .getByRole("button", { name: "回应 🚀", exact: true }),
    ).toBeVisible();
    await reopened
      .getByRole("textbox", { name: "搜索表情符号" })
      .press("Escape");
    await expect(restored.locator(".message-body")).toBeFocused();
    await restored.getByRole("button", { name: "🚀 1", exact: true }).click();
    await expect(
      restored.getByRole("button", { name: "🚀 1", exact: true }),
    ).toHaveCount(0);
    const readSnapshot = async () => {
      const endpoint = endpointSchema.parse(
        JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")),
      );
      const initial = await workerSnapshot(endpoint);
      const conversationId = initial.conversations[0]?.id;
      expect(conversationId).toBeTruthy();
      return workerSnapshot(endpoint, conversationId ? { conversationId } : {});
    };
    await reopened
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("请逐行写出从 1 到 10000 的整数。不要调用工具。");
    await reopened
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const next = await readSnapshot();
          return next.runs[0]?.turnId;
        },
        { timeout: 30000 },
      )
      .toBeTruthy();
    await reopened
      .getByRole("button", { name: "停止回复", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const next = await readSnapshot();
          return next.runs[0]?.status;
        },
        { timeout: 20000 },
      )
      .toBe("cancelled");
    await expect(reopened.locator(".run-state.cancelled")).toBeVisible();
    await reopened
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("只回复 BACKGROUND_OK，不要调用工具。");
    await reopened
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect
      .poll(async () => {
        const next = await readSnapshot();
        return next.runs[0]?.status;
      })
      .toBe("running");
    await reopened.getByRole("button", { name: /^应用菜单/ }).click();
    await reopened.getByRole("menuitem", { name: "设置", exact: true }).click();
    await reopened
      .getByRole("button", { name: "隐藏窗口", exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
      )
      .toBe(false);
    await expect
      .poll(
        async () => {
          const next = await readSnapshot();
          return next.runs[0]?.status;
        },
        { timeout: 90000 },
      )
      .toBe("completed");
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    const finished = await app.firstWindow();
    await finished
      .getByRole("button", { name: /验收 Bot/ })
      .first()
      .click();
    await expect(
      finished.locator(".message.assistant .bubble").last(),
    ).toContainText("BACKGROUND_OK");
    const beforeNew = await readSnapshot();
    const firstConversation = beforeNew.conversations[0];
    expect(firstConversation?.threadId).toBeTruthy();
    await openStartConversation(finished);
    await finished
      .getByRole("dialog", { name: "新建会话", exact: true })
      .getByRole("option", { name: "验收 Bot", exact: true })
      .click();
    await expect(finished.locator(".bot-list .bot-item")).toHaveCount(2);
    await expect(finished.locator(".message")).toHaveCount(0);
    await finished
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("只回复 SECOND_CONVERSATION_OK，不要调用工具。");
    await finished
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(finished.locator(".message.assistant .bubble")).toContainText(
      "SECOND_CONVERSATION_OK",
      { timeout: 90000 },
    );
    await expect(
      finished.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    const afterNew = await readSnapshot();
    expect(afterNew.bots).toHaveLength(1);
    expect(afterNew.conversations).toHaveLength(2);
    expect(afterNew.conversations[0]?.threadId).toBeTruthy();
    expect(afterNew.conversations[0]?.threadId).not.toBe(
      firstConversation?.threadId,
    );
    await finished
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("第二个会话草稿");
    await finished.locator(".bot-list .bot-item").nth(1).click();
    await expect(
      finished.locator(".message.assistant .bubble").last(),
    ).toContainText("BACKGROUND_OK");
    await expect(
      finished.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("");
    await finished.locator(".bot-list .bot-item").nth(0).click();
    await expect(
      finished.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("第二个会话草稿");
    await finished.screenshot({
      scale: "css",
      path: test.info().outputPath("two-conversations.png"),
    });
    // Inject a real worker outage: the UI must retain the failed reaction and recover on reconnect.
    const endpoint = endpointSchema.parse(
      JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")),
    );
    const healthUrl = `http://127.0.0.1:${endpoint.port}/health`;
    const authorization = { Authorization: `Bearer ${endpoint.token}` };
    await fetch(`http://127.0.0.1:${endpoint.port}/command`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        command: { type: "worker.stop" },
      }),
    });
    await expect
      .poll(async () => {
        try {
          return (
            await fetch(healthUrl, {
              headers: authorization,
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      })
      .toBe(false);
    const offlineMessage = finished.locator(".message.assistant").last();
    await offlineMessage.hover();
    await offlineMessage.locator(".message-body").click({ button: "right" });
    await finished
      .getByRole("menu", { name: "消息操作", exact: true })
      .getByRole("button", { name: "回应 🎉", exact: true })
      .click();
    await expect(
      finished
        .getByRole("menu", { name: "消息操作", exact: true })
        .getByRole("alert"),
    ).toContainText("回应未保存");
    await ensureDaemon(directory, {
      executable: process.execPath,
      script: resolve("node_modules/@aster/cli/dist/cli/main.js"),
    });
    await finished
      .getByRole("menu", { name: "消息操作", exact: true })
      .getByRole("button", { name: "回应 🎉", exact: true })
      .click();
    await expect(
      finished.getByRole("menu", { name: "消息操作", exact: true }),
    ).toHaveCount(0);
    await expect(
      offlineMessage.getByRole("button", { name: "🎉 1", exact: true }),
    ).toBeVisible();
    await expect(finished.locator(".banner")).toHaveCount(0);
    await expect(
      finished.getByRole("button", { name: "市场", exact: true }),
    ).toHaveCount(0);
    await finished
      .getByRole("button", { name: "模板操作", exact: true })
      .click();
    await finished
      .getByRole("menuitem", { name: "管理本地模板", exact: true })
      .click();
    const templates = finished.getByRole("dialog", {
      name: "本地模板",
      exact: true,
    });
    await expect(
      templates.getByRole("button", { name: "导入模板文件", exact: true }),
    ).toBeVisible();
    await templates
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await newBot(finished);
    await finished.getByLabel("名称", { exact: true }).fill("代码伙伴");
    await finished
      .getByRole("button", { name: "创建 Bot", exact: true })
      .click();
    await expect(finished.locator(".conversation-title")).toContainText(
      "代码伙伴",
    );
    await finished
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("只回复 MARKET_IMPORT_OK，不调用工具。");
    await finished
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(finished.locator(".message.assistant .bubble")).toContainText(
      "MARKET_IMPORT_OK",
      { timeout: 90000 },
    );
    await expect(
      finished.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    const importedReply = finished.locator(".message.assistant .bubble").last();
    await importedReply.click({ button: "right" });
    const messageMenu = finished.getByRole("menu", {
      name: "消息操作",
      exact: true,
    });
    await expect(
      messageMenu.getByRole("menuitem", { name: "复制", exact: true }),
    ).toBeVisible();
    await expect(
      messageMenu.getByRole("menuitem", { name: "复制请求 ID", exact: true }),
    ).toBeVisible();
    await finished.screenshot({
      path: test.info().outputPath("message-menu.png"),
      scale: "css",
    });
    await messageMenu
      .getByRole("menuitem", { name: "回复", exact: true })
      .click();
    await expect(
      finished.getByRole("region", { name: "引用回复" }),
    ).toContainText("MARKET_IMPORT_OK");
    await expect(
      finished.getByRole("textbox", { name: "消息", exact: true }),
    ).toBeFocused();
    await finished
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("我引用的消息是什么？原样回复引用内容，不调用工具。");
    await expect
      .poll(async () => (await readSnapshot()).conversations[0]?.draft)
      .toContain("我引用的消息");
    const replyInput = await finished
      .getByRole("textbox", { name: "消息", exact: true })
      .boundingBox();
    const replyComposer = await finished.locator(".composer").boundingBox();
    if (!replyInput || !replyComposer)
      throw new Error("引用输入区没有可见布局");
    expect(replyInput.width).toBeGreaterThan(replyComposer.width * 0.8);
    expect(replyInput.height).toBeLessThan(80);
    await finished.screenshot({
      path: test.info().outputPath("reply-draft.png"),
      scale: "css",
    });
    await app.close();
    app = await electron.launch({ args: [resolve(".")], env });
    const replyWindow = await app.firstWindow();
    await replyWindow.locator(".bot-list .bot-item").first().click();
    await expect(
      replyWindow.getByRole("region", { name: "引用回复" }),
    ).toContainText("MARKET_IMPORT_OK");
    await replyWindow
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(
      replyWindow.getByRole("region", { name: "引用回复" }),
    ).toHaveCount(0);
    await expect(
      replyWindow.locator(".message.user .message-quote"),
    ).toContainText("MARKET_IMPORT_OK");
    await expect(replyWindow.locator(".message.assistant .bubble")).toHaveCount(
      2,
      { timeout: 90000 },
    );
    await expect(
      replyWindow.locator(".message.assistant .bubble").last(),
    ).toContainText("MARKET_IMPORT_OK", { timeout: 90000 });
    await expect(
      replyWindow.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    await expect(
      replyWindow.locator(".bot-list .bot-item").first().locator("small"),
    ).toContainText("MARKET_IMPORT_OK");
    await replyWindow.locator(".conversation-title").click();
    await expect(
      replyWindow.getByRole("complementary", { name: "Bot 概览" }),
    ).toBeVisible();
    await replyWindow.screenshot({
      path: test.info().outputPath("bot-overview.png"),
      scale: "css",
    });
    await replyWindow
      .getByRole("button", { name: "Bot 设置", exact: true })
      .click();
    const preferences = replyWindow.getByRole("complementary", {
      name: "Bot 设置",
    });
    await preferences.getByLabel("标签（可选）").fill("真实工具验收");
    await preferences.getByLabel("标签（可选）").press("Tab");
    await expect(preferences.getByRole("status")).toHaveText("已保存");
    await preferences.getByLabel("回复语言").selectOption("zh-CN");
    await expect(preferences.getByRole("status")).toHaveText("已保存");
    await replyWindow.screenshot({
      path: test.info().outputPath("bot-settings.png"),
      scale: "css",
    });
    await replyWindow
      .getByRole("button", { name: "收起 Bot 详情", exact: true })
      .click();
    const beforeTool = await readSnapshot();
    const toolConversation = beforeTool.conversations[0];
    expect(toolConversation).toBeTruthy();
    if (!toolConversation) throw new Error("No tool conversation");
    const content = `FILE_RESULT_${randomUUID()}`;
    const granted = join(
      localWorkspaceDirectory(directory),
      "workspaces",
      toolConversation.botId,
    );
    await writeFile(join(granted, "read-check.txt"), content);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, granted);
    await replyWindow
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("/授权目录");
    await replyWindow.getByRole("option", { name: /^授权目录 / }).click();
    await expect(
      replyWindow.getByLabel("已授权目录", { exact: true }),
    ).toContainText(granted);
    await replyWindow
      .getByRole("textbox", { name: "消息", exact: true })
      .fill(
        "请使用 files 工具列出本会话目录授权，再用 read 读取已授权目录的 read-check.txt。只回复文件的完整内容。",
      );
    await replyWindow
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(
      replyWindow.locator(".message.assistant .bubble").last(),
    ).toContainText(content, { timeout: 90000 });
    await expect(
      replyWindow.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    await replyWindow.screenshot({
      path: test.info().outputPath("real-tool.png"),
      scale: "css",
    });
    await expect(replyWindow.locator(".composer")).toBeInViewport({ ratio: 1 });
    await replyWindow.reload();
    await replyWindow.locator(".bot-list .bot-item").first().click();
    await expect(
      replyWindow.locator(".message.assistant .bubble").last(),
    ).toContainText(content);
    await expect(
      replyWindow.getByLabel("已授权目录", { exact: true }),
    ).toContainText(granted);
    await replyWindow.locator(".conversation-title").click();
    await replyWindow
      .getByRole("button", { name: "Bot 设置", exact: true })
      .click();
    await expect(replyWindow.getByLabel("标签（可选）")).toHaveValue(
      "真实工具验收",
    );
    await expect(replyWindow.getByLabel("回复语言")).toHaveValue("zh-CN");
    await replyWindow
      .getByRole("button", { name: "搜索 Bot 和操作", exact: true })
      .click();
    const palette = replyWindow.getByRole("dialog", {
      name: "搜索",
      exact: true,
    });
    const query = palette.getByRole("combobox", { name: "搜索", exact: true });
    await expect(query).toBeFocused();
    await query.fill("不存在的词");
    await expect(palette.getByText("无结果", { exact: true })).toBeVisible();
    await query.fill("真实工具验收");
    await expect(palette.getByRole("option")).toHaveCount(1);
    await query.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(replyWindow.locator(".conversation-title")).toContainText(
      "代码伙伴",
    );
    await replyWindow
      .getByRole("button", { name: "搜索 Bot 和操作", exact: true })
      .click();
    await replyWindow.screenshot({
      path: test.info().outputPath("search-palette.png"),
      scale: "css",
    });
    await query.fill("设置：更新");
    await query.press("Enter");
    await expect(
      replyWindow.getByRole("region", { name: "设置", exact: true }),
    ).toBeVisible();
    await expect(
      replyWindow.getByRole("heading", { name: "更新", exact: true }),
    ).toBeVisible();
    await replyWindow.keyboard.press("Escape");
    await replyWindow
      .getByRole("button", { name: "搜索 Bot 和操作", exact: true })
      .click();
    await query.press("Escape");
    await expect(
      replyWindow.getByRole("button", { name: "搜索 Bot 和操作", exact: true }),
    ).toBeFocused();
    await replyWindow
      .getByRole("button", { name: /^应用菜单/, exact: true })
      .click();
    await replyWindow
      .getByRole("menuitem", { name: "设置", exact: true })
      .click();
    await replyWindow
      .getByRole("button", { name: "用量与账单", exact: true })
      .click();
    await replyWindow
      .getByRole("button", { name: "刷新用量", exact: true })
      .click();
    await expect(
      replyWindow.getByRole("region", { name: "提供商用量", exact: true }),
    ).toContainText("Pi 不提供模型账户的共享额度查询", { timeout: 45000 });
    await expect(replyWindow.getByRole("progressbar")).toHaveCount(0);
    await replyWindow.screenshot({
      path: test.info().outputPath("real-usage.png"),
      scale: "css",
    });
    await replyWindow.keyboard.press("Escape");
  } finally {
    await app.close();
    try {
      if (await daemonStatus(directory)) await stopDaemon(directory);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 15,
        retryDelay: 200,
      });
    }
  }
});
