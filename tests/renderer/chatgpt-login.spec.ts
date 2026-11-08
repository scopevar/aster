import { test, expect } from "../helpers/renderer-app.js";
import {
  chatGPTAuthRequestSchema,
  type ChatGPTAuthStatus,
} from "../../src/shared/chatgpt-auth.js";
import {
  agentConnectionsRequestSchema,
  type AgentConnectionsStatus,
} from "../../src/shared/agent-connections.js";

// Owner: real connection editor at the Main contract. Worker tests own OAuth,
// encryption and callback cleanup; this covers discoverability and save gating.
test("ChatGPT subscription login supports cancel, retry, save and logout without API key entry", async ({
  renderer,
}, info) => {
  let auth: ChatGPTAuthStatus = {
    state: "idle",
    authenticated: false,
    message: "",
    models: [],
  };
  let status: AgentConnectionsStatus = {
    revision: "0",
    config: { defaultAgent: "", connections: [] },
    path: "pi-models.json",
    active: "",
    override: null,
    notice: "",
  };
  let failNext = false;
  const cancelled: string[] = [];
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1314, height: 963 },
    handlers: {
      agentConnections: (input) => {
        const request = agentConnectionsRequestSchema.parse(input);
        if (request.action === "save")
          status = {
            ...status,
            revision: "1",
            config: request.config,
            notice: "已保存",
          };
        return status;
      },
      chatGPTAuth: (input) => {
        const request = chatGPTAuthRequestSchema.parse(input);
        if (request.action === "start")
          auth = failNext
            ? {
                state: "error",
                authenticated: false,
                message: "ChatGPT 登录未完成，请重试。",
                models: [],
              }
            : {
                state: "pending",
                authenticated: false,
                message: "请在系统浏览器中完成 ChatGPT 授权。",
                id: request.id,
                models: [],
              };
        if (request.action === "cancel") {
          cancelled.push(request.id);
          auth = {
            state: "idle",
            authenticated: false,
            message: "已取消登录。",
            models: [],
          };
        }
        if (request.action === "logout")
          auth = {
            state: "idle",
            authenticated: false,
            message: "已退出本机 ChatGPT 登录。",
            models: [],
          };
        return {
          ...auth,
          credentialType: auth.authenticated ? "oauth" : "none",
        };
      },
    },
  });
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("region", { name: "设置", exact: true });
  await settings
    .getByRole("button", { name: "模型与连接", exact: true })
    .click();
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  const dialog = page.locator(".connection-add-dialog");
  await dialog.getByRole("button", { name: /OpenAI api\.openai\.com/ }).click();
  await dialog.getByLabel("模型", { exact: true }).fill("gpt-5.4");
  await dialog.getByText("应用凭证库", { exact: true }).click();
  await dialog.getByLabel("API Key", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("before-api-key.png"),
    animations: "disabled",
  });
  await dialog.getByText("ChatGPT 订阅登录", { exact: true }).click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveCount(0);
  const save = dialog.getByRole("button", { name: "添加供应商", exact: true });
  await expect(save).toBeDisabled();
  await dialog
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("系统浏览器");
  await expect(save).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("pending-browser.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已取消登录");
  expect(cancelled).toHaveLength(1);
  failNext = true;
  await dialog
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("登录未完成");
  await expect(save).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("login-failed.png"),
    animations: "disabled",
  });
  failNext = false;
  await dialog
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "取消登录", exact: true }),
  ).toBeVisible();
  auth = {
    state: "connected",
    authenticated: true,
    message: "已连接 ChatGPT 订阅。",
    models: [{ id: "account-model", name: "Account Model" }],
  };
  await expect(dialog.getByRole("status")).toContainText("已连接 ChatGPT");
  await expect(save).toBeEnabled();
  await expect(dialog.locator("#chatgpt-models option")).toHaveAttribute(
    "value",
    "account-model",
  );
  await dialog.getByLabel("模型", { exact: true }).fill("account-model");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [
      { width: 1314, height: 963 },
      { width: 760, height: 550 },
    ]) {
      await page.setViewportSize(size);
      await dialog
        .getByRole("button", { name: "重新登录 ChatGPT", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        dialog.getByRole("button", { name: "退出登录", exact: true }),
      ).toBeInViewport();
      expect(
        await dialog
          .locator(".connection-editor")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`connected-${colorScheme}-${size.width}.png`),
        animations: "disabled",
      });
    }
  }
  await page.setViewportSize({ width: 1314, height: 963 });
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(status.config.connections[0]).toMatchObject({
    provider: "openai",
    auth: "chatgpt",
    api: "native",
    baseUrl: "",
    model: "account-model",
  });
  await settings
    .getByRole("button", { name: "编辑 openai", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("已退出本机");
  await expect(
    settings.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await settings.getByText("应用凭证库", { exact: true }).click();
  await expect(settings.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "placeholder",
    "输入 API Key",
  );
  await expect(
    settings.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  expect(renderer.unhandled).toEqual([]);
});
