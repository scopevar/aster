import { AppError } from "../../src/shared/core.js";
import {
  agentConnectionsRequestSchema,
  agentConnectionsStatusSchema,
  type AgentConnectionsStatus,
} from "../../src/shared/agent-connections.js";
import { test, expect } from "../helpers/renderer-app.js";

const failure = "Pi 模型请求失败；请检查提供商、认证和模型配置，未自动重试。";

// Owner: connection editor check/test failures must use the shared toast surface,
// not the form-footer inline error that previously looked like a JSON/key issue.
test("connection inference test failures appear as toasts instead of inline form errors", async ({
  renderer,
}, info) => {
  const status: AgentConnectionsStatus = agentConnectionsStatusSchema.parse({
    revision: "0",
    config: { defaultAgent: "", connections: [] },
    path: "pi-models.json",
    active: "",
    override: null,
    notice: "",
  });
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1314, height: 963 },
    handlers: {
      agentConnections: (input) => {
        const request = agentConnectionsRequestSchema.parse(input);
        if (request.action === "status") return status;
        if (
          request.action === "check" ||
          request.action === "test" ||
          request.action === "jev.test"
        )
          throw new AppError("unavailable", failure);
        if (request.action === "save")
          throw new AppError("conflict", "配置已修改，请重新加载后再保存。");
        return status;
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
  await dialog.getByRole("button", { name: /自定义配置/ }).click();
  await dialog.getByLabel("连接名称", { exact: true }).fill("mify");
  await dialog.getByLabel("模型提供商", { exact: true }).fill("mify");
  await dialog
    .getByLabel("接口地址", { exact: true })
    .fill("https://api.llm.example.com/v1");
  await dialog.getByLabel("模型", { exact: true }).fill("demo-model");
  await dialog.getByText("应用凭证库", { exact: true }).click();
  await dialog.getByLabel("API Key", { exact: true }).fill("draft-secret");
  const testButton = dialog.getByRole("button", {
    name: "真实推理测试",
    exact: true,
  });
  await testButton.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("connection-before-test.png"),
    animations: "disabled",
  });
  const form = dialog.getByRole("form", { name: "连接配置" });
  const before = await form.boundingBox();
  await testButton.click();
  await expect(page.getByText(failure, { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("connection-test-result.png"),
    animations: "disabled",
  });
  const notice = page
    .getByRole("region", { name: "通知", exact: true })
    .getByRole("alertdialog", { name: failure });
  await expect(notice).toBeVisible();
  await notice.hover();
  expect(await form.boundingBox()).toEqual(before);
  await expect(dialog.locator(".connection-editor .error")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [760, 1314]) {
      await page.setViewportSize({ width, height: 963 });
      await expect(notice).toBeInViewport({ ratio: 1 });
      await notice.hover();
      await page.screenshot({
        path: info.outputPath(`connection-test-${colorScheme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
  await notice.getByRole("button", { name: "关闭提示" }).click();
  await expect(notice).toHaveCount(0);
  await dialog.getByRole("button", { name: "检查配置", exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(dialog.locator(".connection-editor .error")).toHaveCount(0);
  await notice.getByRole("button", { name: "关闭提示" }).click();
  await dialog.getByRole("button", { name: "添加供应商", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "配置已修改，请重新加载后再保存。",
  );
  await expect(notice).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("connection-save-conflict.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByText("Jev 辅助决策", { exact: true }).click();
  await page.getByLabel("Jev API Key", { exact: true }).fill("draft-jev-key");
  await page
    .getByRole("button", { name: "测试 Jev 连接", exact: true })
    .click();
  await expect(notice).toBeVisible();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
