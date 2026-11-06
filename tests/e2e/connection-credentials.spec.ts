import { newBot } from "./new-conversation.js";
import { test, expect } from "../helpers/desktop-test.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { piModelServer } from "../helpers/pi-model-server.js";
import { selectSetting } from "../helpers/settings-controls.js";
import { openDesktop } from "../helpers/local-desktop.js";

test("saved API keys support attachments, cancellation and restart without leaking secrets or replaying requests", async ({
  desktop,
}, info) => {
  const directory = desktop.directory;
  let interruptedStreams = 0;
  const model = await piModelServer((request, send, response) => {
    const isTest = request.messages.some((message) =>
      JSON.stringify(message.content).includes("Connectivity inference test"),
    );
    if (JSON.stringify(request.messages.at(-1)?.content).includes("等待停止")) {
      response.once("close", () => {
        interruptedStreams++;
      });
      send({ role: "assistant", content: "正在等待停止" });
      return;
    }
    send({
      role: "assistant",
      content: isTest ? '{"ok":true}' : "凭证连接成功",
    });
    send({}, "stop");
  });
  let app = await desktop.launch({
    colorScheme: null,
  });
  try {
    let page = await openDesktop(app);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      nativeTheme.themeSource = "light";
      BrowserWindow.getAllWindows()[0]?.setSize(1050, 850);
    });
    await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await page
      .getByRole("region", { name: "设置", exact: true })
      .getByRole("button", { name: "模型与连接", exact: true })
      .click();
    const view = page.getByLabel("模型与连接配置", { exact: true });
    await view.getByRole("button", { name: "添加连接", exact: true }).click();
    const add = page.getByRole("dialog", { name: "添加连接", exact: true });
    await add.getByRole("button", { name: /自定义配置/ }).click();
    await add.getByLabel("连接名称", { exact: true }).fill("key-provider");
    await add.getByLabel("模型提供商", { exact: true }).fill("fixture");
    await add
      .getByLabel("接口地址", { exact: true })
      .fill(model.connection.baseUrl);
    await add.getByLabel("模型", { exact: true }).fill("fixture");
    await add.getByText("应用凭证库", { exact: true }).click();
    await expect(
      add.getByRole("radio", { name: "应用凭证库", exact: true }),
    ).toBeChecked();
    let key = add.getByLabel("API Key", { exact: true });
    await expect(key).toHaveAttribute("type", "password");
    await expect(
      add.getByRole("button", { name: "添加供应商", exact: true }),
    ).toBeDisabled();
    await add.getByRole("button", { name: "检查配置", exact: true }).click();
    await expect(add.getByRole("alert")).toHaveText("请填写 API Key。");
    await key.fill("desktop-fixture-key");
    await add.getByRole("button", { name: /配置预览/ }).click();
    await expect(
      add.getByLabel("配置预览 JSON", { exact: true }),
    ).not.toContainText("desktop-fixture-key");
    await add.getByRole("button", { name: /配置预览/ }).click();
    await add.getByRole("button", { name: "检查配置", exact: true }).click();
    await expect(
      page.getByText("配置检查通过，未向模型发出请求", { exact: true }).first(),
    ).toBeVisible();
    expect(model.requests).toHaveLength(0);
    await add
      .getByRole("button", { name: "真实推理测试", exact: true })
      .click();
    await expect(
      page.getByText("真实推理测试通过", { exact: true }).first(),
    ).toBeVisible();
    expect(model.headers[0]?.authorization).toBe("Bearer desktop-fixture-key");
    await expect(
      readFile(join(directory, "agent", "pi-auth.sealed")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await key.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("api-key-entry.png"),
      scale: "css",
    });
    await add.getByRole("button", { name: "添加供应商", exact: true }).click();
    await expect(add).toHaveCount(0);
    await view
      .getByRole("button", { name: "编辑 key-provider", exact: true })
      .click();
    key = view.getByLabel("API Key", { exact: true });
    await expect(key).toBeEmpty();
    await expect(key).toHaveAttribute("placeholder", "已保存，留空保持不变");
    const status = await page.evaluate(() =>
      window.aster.agentConnections({ action: "status" }),
    );
    expect(status.success).toBe(true);
    expect(JSON.stringify(status)).not.toContain("desktop-fixture-key");
    expect(
      (await readFile(join(directory, "agent", "pi-auth.sealed"))).includes(
        Buffer.from("desktop-fixture-key"),
      ),
    ).toBe(false);
    expect(
      await readFile(join(directory, "agent", "pi-models.json"), "utf8"),
    ).not.toContain("desktop-fixture-key");
    await view.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(
      view.getByRole("button", { name: "编辑 key-provider", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    // Returning home reloads model status; wait before choosing its creation action.
    await expect(
      page
        .getByRole("region", { name: "开始使用 Aster" })
        .getByRole("button", { name: "创建助手", exact: true }),
    ).toBeVisible();
    await newBot(page);
    const dialog = page.getByRole("dialog", {
      name: "创建新 Bot",
      exact: true,
    });
    await dialog.getByLabel("名称", { exact: true }).fill("Key Bot");
    await selectSetting(page, "Bot 供应商", "key-provider · fixture");
    await dialog.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(dialog).toBeHidden();
    const attachmentText = `BETA_ATTACHMENT_${randomUUID()}`;
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    await (
      await picker
    ).setFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(attachmentText),
    });
    await page
      .getByRole("button", { name: "预览 notes.txt", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "notes.txt", exact: true }),
    ).toContainText(attachmentText);
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("简短回答，不使用工具。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("凭证连接成功", { timeout: 30000 });
    expect(model.headers.at(-1)?.authorization).toBe(
      "Bearer desktop-fixture-key",
    );
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      attachmentText,
    );
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("api-key-bot-reply.png"),
      scale: "css",
    });
    const completedRequests = model.requests.length;
    await desktop.stop();
    app = await desktop.launch();
    page = await app.firstWindow();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("凭证连接成功", { timeout: 35000 });
    expect(model.requests).toHaveLength(completedRequests);
    // Renderer readiness does not guarantee native input focus after restart.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.focus(),
    );
    await page.bringToFront();
    const message = page.getByRole("textbox", { name: "消息", exact: true });
    await message.click();
    await message.fill("等待停止");
    await expect(message).toHaveValue("等待停止");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("正在等待停止");
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await expect.poll(() => interruptedStreams).toBe(1);
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    const cancelledRequests = model.requests.length;
    await desktop.stop();
    app = await desktop.launch();
    page = await app.firstWindow();
    await expect(
      page.locator(".message.assistant .bubble").last(),
    ).toContainText("正在等待停止", { timeout: 35000 });
    expect(model.requests).toHaveLength(cancelledRequests);
  } finally {
    await model.close();
  }
});
