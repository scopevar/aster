import { randomUUID } from "node:crypto";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";
import { AppError } from "../../src/shared/core.js";
import { test, expect } from "../helpers/renderer-app.js";

const configured = agentConnectionsStatusSchema.parse({
  revision: "1",
  config: {
    defaultAgent: "local",
    connections: [
      {
        id: "local",
        enabled: true,
        provider: "local",
        model: "local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        auth: "none",
      },
    ],
  },
  path: "agents.json",
  override: null,
  active: "local",
  notice: "",
});

// The built renderer owns first-run navigation: an empty workspace offers an
// actionable next step, never an unusable composer or an empty conversation pane.
// Existing startup coverage only proved that a Bot could be created from the + menu.
test("first launch guides model setup and refreshes the next step after returning from settings", async ({
  renderer,
}, info) => {
  let hasConnection = false;
  const page = await renderer.open({
    size: { width: 1050, height: 768 },
    handlers: {
      agentConnections: () =>
        hasConnection
          ? configured
          : {
              ...configured,
              config: { defaultAgent: "", connections: [] },
              active: "尚未添加供应商",
            },
    },
  });
  const start = page.getByRole("region", { name: "开始使用 Aster" });
  const connect = start.getByRole("button", { name: "连接模型", exact: true });
  await expect(connect).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "搜索会话和操作" }),
  ).toHaveCount(0);
  await expect(page.getByText("新会话", { exact: true })).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [
      { width: 1050, height: 768 },
      { width: 760, height: 550 },
    ]) {
      await page.setViewportSize(size);
      await expect(connect).toBeInViewport({ ratio: 1 });
      await expect(start.getByRole("heading")).toBeInViewport({ ratio: 1 });
      expect(
        await start.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`start-${colorScheme}-${size.width}.png`),
      });
    }
  }
  await connect.click();
  const settings = page.getByRole("region", { name: "设置", exact: true });
  await expect(
    settings.getByRole("heading", { name: "模型与连接", exact: true }),
  ).toBeVisible();
  hasConnection = true;
  await settings.getByRole("button", { name: "返回应用", exact: true }).click();
  const create = start.getByRole("button", { name: "创建助手", exact: true });
  await expect(create).toBeVisible();
  await create.click();
  const dialog = page.getByRole("dialog", { name: "创建新 Bot", exact: true });
  await dialog.getByLabel("名称", { exact: true }).fill("我的第一个助手");
  await dialog.getByRole("button", { name: "创建 Bot", exact: true }).click();
  await expect(page.locator(".conversation-title")).toHaveText(
    "我的第一个助手",
  );
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "搜索会话和操作" }),
  ).toBeVisible();
  await expect(start).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});

test("an unavailable model configuration stays distinct from first-time setup and can be retried", async ({
  renderer,
}) => {
  let failed = true;
  const page = await renderer.open({
    handlers: {
      agentConnections: () => {
        if (failed) throw new AppError("unavailable", "模型配置暂时不可用");
        return configured;
      },
    },
  });
  const start = page.getByRole("region", { name: "开始使用 Aster" });
  await expect(start.getByRole("alert")).toContainText("模型配置暂时不可用");
  await expect(
    start.getByRole("button", { name: "创建助手", exact: true }),
  ).toHaveCount(0);
  failed = false;
  await start.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    start.getByRole("button", { name: "创建助手", exact: true }),
  ).toBeVisible();
  await expect(start.getByRole("alert")).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});

test("available assistants open a real new conversation while returning users restore their last chat", async ({
  renderer,
  page,
}) => {
  const store = renderer.store();
  const created = store.execute({
    id: randomUUID(),
    command: {
      type: "bot.create",
      name: "写作助手",
      description: "一起打磨文字",
    },
  });
  if (!created.conversationId) throw Error("Missing conversation");
  store.execute({
    id: randomUUID(),
    command: {
      type: "conversation.update",
      conversationId: created.conversationId,
      hidden: true,
      pinned: false,
    },
  });
  await renderer.open();
  const start = page.getByRole("region", { name: "开始使用 Aster" });
  await start
    .getByRole("button", { name: "与写作助手开始对话", exact: true })
    .click();
  await expect(page.locator(".conversation-title")).toHaveText("写作助手");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeVisible();
  const remembered = await page.evaluate(() =>
    localStorage.getItem("last-conversation"),
  );
  expect(remembered).toBeTruthy();
  expect(remembered).not.toBe(created.conversationId);
  expect(store.views.snapshot({}).conversations).toHaveLength(2);
  store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "另一个助手", description: "" },
  });
  await page.reload();
  await expect(page.locator(".conversation-title")).toHaveText("写作助手");
  await expect(start).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("last-conversation")),
  ).toBe(remembered);
  expect(renderer.unhandled).toEqual([]);
});

test("a disabled saved provider does not skip the connect-model step", async ({
  renderer,
}) => {
  const page = await renderer.open({
    handlers: {
      agentConnections: () => ({
        ...configured,
        config: {
          ...configured.config,
          connections: configured.config.connections.map((connection) => ({
            ...connection,
            enabled: false,
          })),
        },
      }),
    },
  });
  const start = page.getByRole("region", { name: "开始使用 Aster" });
  await expect(
    start.getByRole("button", { name: "连接模型", exact: true }),
  ).toBeVisible();
  await expect(
    start.getByRole("button", { name: "创建助手", exact: true }),
  ).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
