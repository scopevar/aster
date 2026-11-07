import { randomUUID } from "node:crypto";
import { test, expect } from "../helpers/renderer-app.js";
import { newGroup } from "../e2e/new-conversation.js";

// The real renderer owns title navigation, toolbar presentation and focus after
// the browser file input reports cancellation. Existing tests did not cover these
// states; Main and the OS picker are outside this renderer-only contract.
for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 1052, height: 769 },
    { width: 1314, height: 963 },
  ]) {
    test(`${colorScheme} conversation chrome at ${size.width}px`, async ({
      renderer,
      page,
    }, info) => {
      renderer.store().execute({
        id: randomUUID(),
        command: { type: "bot.create", name: "test", description: "" },
      });
      await page.clock.install();
      await renderer.open({ colorScheme, size });
      const row = page.locator(".bot-item");
      await row.click();
      const title = page.locator(".conversation-title");
      await expect(title).toHaveText("test");
      await page.mouse.move(size.width - 40, 150);
      await row.hover();
      await page.clock.runFor(600);
      await page.screenshot({ path: info.outputPath("sidebar-hover.png") });
      await expect
        .soft(page.getByRole("tooltip").filter({ hasText: "test" }))
        .toHaveCount(0);
      await page.getByRole("separator", { name: "侧栏宽度" }).press("Home");
      await page.mouse.move(size.width - 40, 150);
      await row.hover();
      await page.clock.runFor(600);
      await expect(
        page.getByRole("tooltip").filter({ hasText: "test" }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath("collapsed-hover.png") });
      await page.getByRole("separator", { name: "侧栏宽度" }).press("End");
      await page.mouse.click(size.width - 40, 150);

      const template = page.getByRole("button", {
        name: "模板操作",
        exact: true,
      });
      const plugin = page.getByRole("button", {
        name: "管理本地插件",
        exact: true,
      });
      const routines = page.getByRole("button", {
        name: "查看并管理任务",
        exact: true,
      });
      const toolbarColor = await template.evaluate(
        (el) => getComputedStyle(el).color,
      );
      await expect.soft(plugin).toHaveCSS("color", toolbarColor);
      await expect.soft(routines).toHaveCSS("color", toolbarColor);
      await title.hover();
      await page.screenshot({ path: info.outputPath("title-hover.png") });
      const nameBounds = await title.boundingBox();
      const kindBounds = await page
        .locator(".conversation-header > .conversation-kind")
        .boundingBox();
      expect
        .soft(kindBounds!.x - (nameBounds!.x + nameBounds!.width))
        .toBeGreaterThanOrEqual(8);
      await title.click();
      await expect(page.locator(".details")).toBeVisible();
      await page.screenshot({ path: info.outputPath("title-open.png") });
      await expect
        .soft(
          page.getByRole("complementary", { name: "Bot 设置", exact: true }),
        )
        .toBeVisible();
      await expect.soft(page.locator(".details-heading")).toContainText("设置");
      await page
        .getByRole("button", { name: "收起 Bot 详情", exact: true })
        .click();

      const message = page.getByRole("textbox", { name: "消息", exact: true });
      await message.fill("保留这段草稿");
      const attach = page.getByRole("button", {
        name: "添加附件",
        exact: true,
      });
      const idleShadow = await attach.evaluate(
        (el) => getComputedStyle(el).boxShadow,
      );
      const chooser = page.waitForEvent("filechooser");
      await attach.click();
      await chooser;
      // Playwright intercepts the native picker; deliver its cancel event at the
      // input boundary without uploading files or emulating application state.
      await page.locator('input[type="file"]').dispatchEvent("cancel");
      await page.mouse.move(size.width - 40, 150);
      await page.screenshot({ path: info.outputPath("attachment-cancel.png") });
      await expect.soft(message).toBeFocused();
      await expect(message).toHaveValue("保留这段草稿");
      await expect.soft(attach).toHaveCSS("box-shadow", idleShadow);
      await message.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(attach).toBeFocused();
      await expect(attach).not.toHaveCSS("box-shadow", idleShadow);
      await page.screenshot({
        path: info.outputPath("attachment-keyboard.png"),
      });
      expect(renderer.unhandled).toEqual([]);
    });
  }
}

test("cancelling an attachment in a new group returns to its draft", async ({
  renderer,
}) => {
  renderer.store().execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "test", description: "" },
  });
  const page = await renderer.open({ handlers: { skillCatalog: () => [] } });
  await page.locator(".bot-item", { hasText: "test" }).click();
  await newGroup(page);
  await page
    .getByRole("option", { name: "test 添加到群聊", exact: true })
    .click();
  const message = page.getByRole("textbox", { name: "群聊消息", exact: true });
  await message.fill("群聊草稿");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await chooser;
  await page
    .getByLabel("选择群聊附件", { exact: true })
    .dispatchEvent("cancel");
  await expect(message).toBeFocused();
  await expect(message).toHaveValue("群聊草稿");
  expect(renderer.unhandled).toEqual([]);
});
