import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/core.js";
import { test, expect } from "../helpers/renderer-app.js";

// Chat cards and their management surfaces use the built renderer and real Store.
// The old receipt stacked its avatar below the title and ran metadata into the
// primary action; toolbar icons also had no hover descriptions.
for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 1314, height: 963 },
    { width: 760, height: 550 },
  ]) {
    test(`template cards and toolbars remain readable in ${colorScheme} at ${size.width}px`, async ({
      renderer,
    }, info) => {
      const store = renderer.store();
      const bot = store.execute({
        id: randomUUID(),
        command: { type: "bot.create", name: "模板验收", description: "" },
      });
      if (!bot.conversationId) throw Error("Missing template conversation");
      store.execute({
        id: randomUUID(),
        command: {
          type: "message.send",
          conversationId: bot.conversationId,
          text: "创建模板草稿",
        },
      });
      const job = store.runs.claim();
      if (!job) throw Error("Missing template run");
      store.toolOperations.templateToolRequest(job, {
        callId: "template-layout",
        operation: {
          action: "create",
          name: "Antigravity Assistant",
          description: "Antigravity 智能编程助手配置草稿",
          tags: "编程",
          includeSkills: false,
          includeRoutines: false,
        },
      });
      store.runs.output.writeText(
        job,
        "receipt-followup",
        "已创建本地模板草稿，可以查看后选择要导出的内容。",
        true,
      );
      store.runs.finish(job.id, "completed", null);
      const page = await renderer.open({
        colorScheme,
        size,
        handlers: {
          templates: (query) => {
            if (query.kind === "local")
              return {
                kind: "local",
                data: store.templateOperations.localTemplates(),
              };
            if (query.kind === "draft")
              return {
                kind: "draft",
                data: store.templateOperations.templateDraft(query.id),
              };
            throw new AppError("unavailable", "Unexpected template read");
          },
          plugins: () => ({ plugins: [], preview: null, notice: "" }),
        },
      });
      await page.locator(".bot-item").filter({ hasText: "模板验收" }).click();
      const card = page.getByRole("region", {
        name: "模板草稿卡",
        exact: true,
      });
      await card.scrollIntoViewIfNeeded();
      const title = await card
        .getByRole("heading", { name: "Antigravity Assistant", exact: true })
        .boundingBox();
      const avatar = await card.locator(".avatar").boundingBox();
      if (!title || !avatar) throw Error("Missing template header");
      expect.soft(title.x).toBeGreaterThan(avatar.x + avatar.width);
      expect(
        await card.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("template-message.png"),
        animations: "disabled",
      });

      for (const label of ["模板操作", "管理本地插件", "查看并管理任务"]) {
        await page.getByRole("button", { name: label, exact: true }).hover();
        await expect(
          page.getByRole("tooltip", { name: label, exact: true }),
        ).toBeVisible();
      }
      await page.screenshot({
        path: info.outputPath("toolbar-tooltip.png"),
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
        plugins.getByText("该 Bot 尚未安装插件。", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("plugins-empty.png"),
        animations: "disabled",
      });
      await plugins
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();

      await page.getByRole("button", { name: "模板操作", exact: true }).click();
      await expect(
        page.getByRole("menu", { name: "模板操作", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("template-menu.png"),
        animations: "disabled",
      });
      await page
        .getByRole("menuitem", { name: "管理本地模板", exact: true })
        .click();
      const templates = page.getByRole("dialog", {
        name: "本地模板",
        exact: true,
      });
      await expect(
        templates.getByRole("button", {
          name: "Antigravity Assistant",
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("template-library.png"),
        animations: "disabled",
      });
      await templates
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
      await card
        .getByRole("button", { name: "管理本地模板", exact: true })
        .click();
      await expect(
        templates.getByRole("textbox", { name: "模板名称", exact: true }),
      ).toHaveValue("Antigravity Assistant");
      await page.screenshot({
        path: info.outputPath("template-editor.png"),
        animations: "disabled",
      });
      expect(renderer.unhandled).toEqual([]);
    });
  }
}

test("an empty template library keeps its creation choices and action visible", async ({
  renderer,
}, info) => {
  const store = renderer.store();
  store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "模板起点", description: "" },
  });
  const page = await renderer.open({
    handlers: {
      templates: (query) => {
        if (query.kind === "local")
          return {
            kind: "local",
            data: store.templateOperations.localTemplates(),
          };
        throw new AppError("unavailable", "Unexpected empty-library read");
      },
    },
  });
  await page.locator(".bot-item").filter({ hasText: "模板起点" }).click();
  await page.getByRole("button", { name: "模板操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "管理本地模板", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "本地模板", exact: true });
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [
      { width: 1314, height: 963 },
      { width: 760, height: 550 },
    ]) {
      await page.setViewportSize(size);
      await expect(
        dialog.getByRole("button", { name: "创建本地模板", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `templates-empty-${colorScheme}-${size.width}.png`,
        ),
        animations: "disabled",
      });
    }
  }
  expect(renderer.unhandled).toEqual([]);
});
