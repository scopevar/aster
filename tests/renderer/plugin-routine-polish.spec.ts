import { randomUUID } from "node:crypto";
import { idSchema } from "../../src/shared/core.js";
import { test, expect } from "../helpers/renderer-app.js";

// The real renderer owns refresh feedback and scroll containment. A held Main
// reply exposes the old unrelated disabled-state flash; no network is contacted.
for (const colorScheme of ["light", "dark"] as const) {
  test(`plugin refresh stays local and routine controls stay reachable in ${colorScheme}`, async ({
    renderer,
  }, info) => {
    const store = renderer.store();
    const botId = idSchema.parse(
      store.execute({
        id: randomUUID(),
        command: { type: "bot.create", name: "验收助手", description: "" },
      }).id,
    );
    let hold = false;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await renderer.open({
      colorScheme,
      size: { width: 1052, height: 769 },
      handlers: {
        plugins: async (request) => {
          if (hold && request.action === "list") await pending;
          return {
            plugins: [],
            preview: null,
            notice: request.action === "prepare" ? "已取消导入" : "",
          };
        },
      },
    });
    try {
      await page.getByRole("button", { name: "本地市场", exact: true }).click();
      const market = page.getByRole("dialog", {
        name: "本地市场",
        exact: true,
      });
      await page.screenshot({
        path: info.outputPath("market-bots.png"),
        animations: "disabled",
      });
      await market.getByRole("tab", { name: "插件", exact: true }).click();
      const importButton = market.getByRole("button", {
        name: "导入本地插件",
        exact: true,
      });
      await expect(importButton).toBeEnabled();
      await expect(
        market.getByText("该 Bot 尚未安装插件。", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("market-plugins.png"),
        animations: "disabled",
      });
      const refresh = market.getByRole("button", { name: "刷新插件列表" });
      const bounds = await importButton.boundingBox();
      hold = true;
      await refresh.click();
      await expect(refresh).toBeDisabled();
      expect.soft(await importButton.isEnabled()).toBe(true);
      expect.soft(await importButton.boundingBox()).toEqual(bounds);
      await page.screenshot({
        path: info.outputPath("plugin-refresh.png"),
        animations: "disabled",
      });
      await importButton.click();
      const notice = market
        .getByRole("status")
        .filter({ hasText: "已取消导入" });
      await expect(notice).toBeVisible();
      release();
      await expect(refresh).toBeEnabled();
      await expect(notice).toBeVisible();
      await market.getByRole("button", { name: "关闭弹窗" }).click();
      await page.locator(".bot-item").filter({ hasText: "验收助手" }).click();
      await page.getByRole("button", { name: "模板操作", exact: true }).hover();
      await page.screenshot({
        path: info.outputPath("conversation-toolbar.png"),
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "管理本地插件", exact: true })
        .click();
      const plugins = page.getByRole("dialog", {
        name: "本地插件",
        exact: true,
      });
      await expect(
        plugins.getByRole("button", { name: "刷新插件列表" }),
      ).toBeEnabled();
      await page.screenshot({
        path: info.outputPath("plugins-dialog.png"),
        animations: "disabled",
      });
      await plugins.getByRole("button", { name: "关闭弹窗" }).click();
      await page.goto(`https://aster.test/routines.html?botId=${botId}`);
      for (const size of [
        { width: 760, height: 700 },
        { width: 640, height: 550 },
      ]) {
        await page.setViewportSize(size);
        const name = page.getByRole("textbox", {
          name: "任务名称",
          exact: true,
        });
        await expect(name).toBeVisible();
        await page
          .getByRole("textbox", { name: "任务时区", exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          page.getByRole("button", { name: "创建任务", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expect(
          page.getByRole("button", { name: "新建例行任务", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        expect(
          await page
            .locator(".routine-window")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`routines-${size.width}.png`),
          animations: "disabled",
        });
      }
      expect(renderer.unhandled).toEqual([]);
    } finally {
      release();
    }
  });
}
