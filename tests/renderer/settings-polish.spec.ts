import { randomUUID } from "node:crypto";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";
import { sandboxSettingsStatusSchema } from "../../src/shared/tools/sandbox-settings.js";
import { test, expect } from "../helpers/renderer-app.js";

const connections = agentConnectionsStatusSchema.parse({
  revision: "1",
  config: {
    defaultAgent: "demo",
    connections: [
      {
        id: "demo",
        provider: "google",
        model: "gemini-3.8-flash",
        auth: "environment",
        apiKeyEnv: "GEMINI_API_KEY",
      },
    ],
  },
  path: "agents.json",
  override: null,
  active: "demo",
  notice: "",
});
const sandbox = sandboxSettingsStatusSchema.parse({
  enabled: true,
  revision: "0".repeat(64),
  configuration: { dns: { mode: "auto" }, proxy: null },
  resources: { state: "ready", detail: "脚本资源已就绪" },
  test: null,
  notice: "",
});

// The built settings UI owns focus, navigation and stable save feedback. The old
// picker forced focus into search, memory inserted a loading row above the form,
// and sandbox success messages shifted the next section. Main is the only replacement.
for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 1314, height: 963 },
    { width: 1052, height: 769 },
    { width: 760, height: 550 },
  ]) {
    test(`settings preserve focus and layout in ${colorScheme} at ${size.width}px`, async ({
      renderer,
    }, info) => {
      const store = renderer.store();
      store.execute({
        id: randomUUID(),
        command: { type: "bot.create", name: "界面验收", description: "" },
      });
      let hasConnections = false;
      let releaseSave = () => {};
      const saving = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let releaseMemory = () => {};
      const loadingMemory = new Promise<void>((resolve) => {
        releaseMemory = resolve;
      });
      const page = await renderer.open({
        colorScheme,
        size,
        handlers: {
          agentConnections: () =>
            hasConnections
              ? connections
              : {
                  ...connections,
                  config: { defaultAgent: "", connections: [] },
                },
          sharedMemory: async (scope) => {
            await loadingMemory;
            return store.memoryOperations.sharedMemoryView(scope);
          },
          backup: () => ({
            pending: false,
            pendingLabel: null,
            previousAvailable: false,
            notice: "",
          }),
          sandboxSettings: async (request) => {
            if (request.action === "save") {
              await saving;
              return {
                ...sandbox,
                configuration: request.configuration,
                notice: "已保存，下一次启动沙箱时生效",
              };
            }
            return sandbox;
          },
        },
      });
      try {
        await page.getByRole("button", { name: /^应用菜单/ }).click();
        await page.getByRole("menuitem", { name: "设置", exact: true }).click();
        const settings = page.getByRole("region", {
          name: "设置",
          exact: true,
        });
        await expect
          .soft(
            settings.getByRole("heading", { name: "日期与时间", exact: true }),
          )
          .toHaveCount(0);
        await page.screenshot({
          path: info.outputPath("general.png"),
          animations: "disabled",
        });

        await settings
          .getByRole("button", { name: "模型与连接", exact: true })
          .click();
        await expect(
          settings.getByRole("button", { name: "添加连接", exact: true }),
        ).toBeEnabled();
        await page.screenshot({
          path: info.outputPath("connections-empty.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "添加连接", exact: true })
          .click();
        const dialog = page.locator(".connection-add-dialog");
        await expect
          .soft(
            dialog.getByRole("searchbox", { name: "搜索供应商", exact: true }),
          )
          .not.toBeFocused();
        await page.screenshot({
          path: info.outputPath("provider-picker.png"),
          animations: "disabled",
        });
        await page.keyboard.press("Tab");
        await expect
          .soft(
            dialog.getByRole("button", { name: "关闭添加连接", exact: true }),
          )
          .toBeFocused();
        await page.keyboard.press("Tab");
        await expect
          .soft(
            dialog.getByRole("searchbox", { name: "搜索供应商", exact: true }),
          )
          .toBeFocused();
        await dialog.getByRole("button", { name: /自定义配置/ }).click();
        await expect
          .soft(dialog.getByRole("textbox", { name: "连接名称", exact: true }))
          .not.toBeFocused();
        await expect
          .soft(dialog.getByRole("button", { name: "更换供应商", exact: true }))
          .toHaveCount(0);
        await expect
          .soft(
            dialog.getByText("推理测试会发送一次请求，可能产生费用。", {
              exact: true,
            }),
          )
          .toHaveCount(0);
        await page.screenshot({
          path: info.outputPath("connection-editor.png"),
          animations: "disabled",
        });
        const heading = dialog.getByRole("heading", {
          name: "添加自定义供应商",
        });
        const headingBefore = await heading.boundingBox();
        const testing = dialog.getByRole("button", {
          name: "真实推理测试",
          exact: true,
        });
        await testing.scrollIntoViewIfNeeded();
        const advanced = dialog.getByRole("button", {
          name: "高级设置",
          exact: true,
        });
        const testBounds = await testing.boundingBox();
        const advancedBounds = await advanced.boundingBox();
        if (!testBounds || !advancedBounds)
          throw Error("Missing connection controls");
        expect.soft(testBounds.y).toBeLessThan(advancedBounds.y);
        await page.screenshot({
          path: info.outputPath("connection-validation.png"),
          animations: "disabled",
        });
        // Scrolling a long form must leave its title and close control in place.
        expect.soft(await heading.boundingBox()).toEqual(headingBefore);
        await expect.soft(heading).toBeInViewport({ ratio: 1 });
        await dialog
          .getByRole("button", { name: "关闭添加连接", exact: true })
          .click();

        await settings
          .getByRole("button", { name: "共享记忆", exact: true })
          .click();
        await page.screenshot({
          path: info.outputPath("memory-scopes.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "管理本地记忆", exact: true })
          .hover();
        await page.screenshot({
          path: info.outputPath("memory-scopes-hover.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: /管理本地记忆|管理记忆/ })
          .first()
          .click();
        const topic = settings.getByRole("textbox", {
          name: "共享记忆主题",
          exact: true,
        });
        await expect(topic).toBeVisible();
        await expect.soft(topic).not.toBeFocused();
        const beforeRead = await topic.boundingBox();
        releaseMemory();
        await expect(
          settings.getByText("还没有记忆，添加一条吧。", { exact: true }),
        ).toBeVisible();
        expect(await topic.boundingBox()).toEqual(beforeRead);
        await page.screenshot({
          path: info.outputPath("memory-editor.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "新增记忆", exact: true })
          .click();
        await expect(topic).toBeFocused();
        await topic.fill("回复偏好");
        await settings
          .getByRole("textbox", { name: "共享记忆内容" })
          .fill("优先用中文回复，先说明结论，再补充必要细节。");
        await settings
          .getByRole("button", { name: "保存记忆", exact: true })
          .click();
        const memoryEntry = settings
          .getByRole("region", { name: "共享记忆条目" })
          .getByRole("button", { name: /回复偏好/ });
        await expect(memoryEntry).toHaveAttribute("aria-pressed", "true");
        await memoryEntry.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: info.outputPath("memory-saved.png"),
          animations: "disabled",
        });

        await settings
          .getByRole("button", { name: "沙箱", exact: true })
          .click();
        const save = settings.getByRole("button", {
          name: "保存配置",
          exact: true,
        });
        await expect(save).toBeEnabled();
        const diagnosis = settings.getByRole("heading", {
          name: "检查连接",
          exact: true,
        });
        await diagnosis.scrollIntoViewIfNeeded();
        const layout = () =>
          diagnosis.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const scroller = element.closest(".settings-content");
            if (!scroller) throw Error("Missing settings scroller");
            return {
              y: bounds.y + scroller.scrollTop,
              width: bounds.width,
              height: bounds.height,
            };
          });
        const before = await layout();
        await save.click();
        await expect(save).toBeDisabled();
        releaseSave();
        await expect(
          page.getByRole("alertdialog", {
            name: "已保存，下一次启动沙箱时生效",
            exact: true,
          }),
        ).toBeVisible();
        expect(await layout()).toEqual(before);
        await page.screenshot({
          path: info.outputPath("sandbox-saved.png"),
          animations: "disabled",
        });

        await settings
          .getByRole("button", { name: "数据与备份", exact: true })
          .click();
        await expect(
          settings.getByRole("button", { name: "导出本地备份", exact: true }),
        ).toBeEnabled();
        await page.screenshot({
          path: info.outputPath("backup.png"),
          animations: "disabled",
        });

        hasConnections = true;
        await settings
          .getByRole("button", { name: "返回应用", exact: true })
          .click();
        await page.getByRole("button", { name: /^应用菜单/ }).click();
        await page.getByRole("menuitem", { name: "设置", exact: true }).click();
        await settings
          .getByRole("button", { name: "模型与连接", exact: true })
          .click();
        await expect(
          settings.getByRole("button", { name: "编辑 demo", exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: info.outputPath("connections.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "Jev 辅助决策", exact: true })
          .click();
        await expect(
          settings.getByRole("textbox", { name: "Jev Base URL", exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: info.outputPath("jev-settings.png"),
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "保存 Jev 配置", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: info.outputPath("jev-settings-actions.png"),
          animations: "disabled",
        });
        const jevSave = await settings
          .getByRole("button", { name: "保存 Jev 配置" })
          .boundingBox();
        const jevInput = await settings
          .getByRole("textbox", { name: "Jev API Key" })
          .boundingBox();
        if (!jevSave || !jevInput) throw Error("Missing Jev controls");
        expect
          .soft(jevSave.x + jevSave.width)
          .toBeCloseTo(jevInput.x + jevInput.width, 0);
        expect(renderer.unhandled).toEqual([]);
      } finally {
        releaseSave();
        releaseMemory();
      }
    });
  }
}
