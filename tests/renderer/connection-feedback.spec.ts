import {
  agentConnectionsRequestSchema,
  agentConnectionsStatusSchema,
} from "../../src/shared/agent-connections.js";
import { test, expect } from "../helpers/renderer-app.js";

// Existing failure-toast coverage does not exercise in-flight appearance, success,
// or Jev authentication. This owns those contracts through the real renderer.
test("connection checks preserve appearance and report successful results", async ({
  renderer,
}, info) => {
  let status = agentConnectionsStatusSchema.parse({
    revision: "0",
    config: {
      defaultAgent: "demo",
      connections: [
        {
          id: "demo",
          provider: "google",
          model: "demo-model",
          auth: "environment",
          apiKeyEnv: "DEMO_API_KEY",
        },
      ],
    },
    path: "pi-models.json",
    active: "demo",
    override: null,
    notice: "",
  });
  let release = () => {};
  let wait: Promise<void> | undefined;
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1314, height: 963 },
    handlers: {
      agentConnections: async (input) => {
        const request = agentConnectionsRequestSchema.parse(input);
        if (request.action === "status") return status;
        await wait;
        if (request.action === "save")
          status = { ...status, revision: "1", config: request.config };
        return {
          ...status,
          notice:
            request.action === "jev.test"
              ? "Jev 连接与判断测试通过。"
              : "检查通过",
        };
      },
    },
  });
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型与连接", exact: true }).click();
  await page.getByRole("button", { name: "编辑 demo", exact: true }).click();
  const form = page.getByRole("form", { name: "连接配置", exact: true });
  await page
    .getByRole("button", { name: "检查配置", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("check-before.png") });
  const geometry = await form.boundingBox();
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  const saveOpacity = await save.evaluate(
    (node) => getComputedStyle(node).opacity,
  );
  wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole("button", { name: "检查配置", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect.soft(save).toBeVisible();
    await expect(form.getByLabel("连接名称", { exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("check-pending.png") });
    expect(await form.boundingBox()).toEqual(geometry);
    expect
      .soft(
        await form
          .locator('button[type="submit"]')
          .evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe(saveOpacity);
  } finally {
    release();
    wait = undefined;
  }
  const notices = page.getByRole("region", { name: "通知", exact: true });
  await expect(
    notices.getByText("配置检查通过，未向模型发出请求", { exact: true }),
  ).toBeVisible();
  await notices.getByRole("button", { name: "关闭提示" }).click();
  await page.getByRole("button", { name: "真实推理测试", exact: true }).click();
  await expect(
    notices.getByText("真实推理测试通过", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "删除连接", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("delete-placement-and-test-result.png"),
  });
  await notices.getByRole("button", { name: "关闭提示" }).click();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [760, 1314]) {
      await page.setViewportSize({ width, height: 963 });
      const deletion = page.getByRole("button", {
        name: "删除连接",
        exact: true,
      });
      await deletion.scrollIntoViewIfNeeded();
      const deleteBox = await deletion.boundingBox();
      const saveBox = await save.boundingBox();
      if (!deleteBox || !saveBox) throw Error("Missing connection footer");
      expect(deleteBox.y).toBeLessThan(saveBox.y + saveBox.height);
      expect(saveBox.y).toBeLessThan(deleteBox.y + deleteBox.height);
      await page.screenshot({
        path: info.outputPath(`connection-footer-${colorScheme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByText("Jev 辅助决策", { exact: true }).click();
  await page.getByLabel("Jev API Key", { exact: true }).fill("audit-fake-key");
  await page
    .getByRole("button", { name: "测试 Jev 连接", exact: true })
    .click();
  await expect(
    notices.getByText("Jev 连接与判断测试通过", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("jev-success.png") });
  await notices.getByRole("button", { name: "关闭提示" }).click();
  const jev = page.getByRole("form", { name: "Jev 配置", exact: true });
  await jev.getByText("环境变量", { exact: true }).click();
  await expect(jev.getByLabel("Jev API Key", { exact: true })).toHaveCount(0);
  await jev
    .getByLabel("Jev 密钥环境变量名", { exact: true })
    .fill("TEAM_JEV_KEY");
  await jev.getByRole("button", { name: "保存 Jev 配置", exact: true }).click();
  await expect(
    notices.getByText("已保存，下一次运行生效", { exact: true }),
  ).toBeVisible();
  expect(status.config.jev?.auth).toBe("environment");
  expect(status.config.jev?.apiKeyEnv).toBe("TEAM_JEV_KEY");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [760, 1314]) {
      await page.setViewportSize({ width, height: 963 });
      await expect(
        jev.getByLabel("Jev 密钥环境变量名", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath(`jev-environment-${colorScheme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
  expect(renderer.unhandled).toEqual([]);
});
