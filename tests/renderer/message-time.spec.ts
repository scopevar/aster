import type { Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { envelopeSchema } from "../../src/shared/commands.js";
import type { Store } from "../../src/storage/store.js";
import { test, expect } from "../helpers/renderer-app.js";

function seedMessages(store: Store) {
  const created = store.execute(
    envelopeSchema.parse({
      id: randomUUID(),
      command: { type: "bot.create", name: "时间布局", description: "" },
    }),
  );
  store.execute(
    envelopeSchema.parse({
      id: randomUUID(),
      command: {
        type: "message.send",
        conversationId: created.conversationId,
        text: "1",
      },
    }),
  );
  const job = store.runs.claim();
  if (!job) throw Error("Missing run");
  store.runs.output.writeText(job, "before", "执行前的消息", true);
  store.runs.output.writeTool(job, "command", {
    kind: "command",
    command: "echo timestamp",
    cwd: "/workspace",
    status: "completed",
    output: "卡片展开时的输出\n".repeat(8),
    truncated: false,
    exitCode: 0,
    durationMs: 250,
  });
  store.runs.output.writeText(job, "after", "处理完成", true);
  store.runs.finish(job.id, "completed", null);
}
async function timestampBounds(message: Locator) {
  await message.page().mouse.move(10, 10);
  await expect(message.getByRole("toolbar", { name: "消息操作" })).toHaveCount(
    0,
  );
  const time = message.locator(".message-time");
  await expect(time).toBeHidden();
  const body = message.locator(".message-body");
  // Position within the scrolled list: a late snapshot may follow the bottom, which is not a layout shift.
  const layout = () =>
    body.evaluate((element) => {
      const list = element.closest(".messages");
      if (!list) throw Error("message list missing");
      const b = element.getBoundingClientRect(),
        l = list.getBoundingClientRect();
      return {
        x: b.x - l.x,
        y: b.y - l.y + list.scrollTop,
        width: b.width,
        height: b.height,
      };
    });
  // hover() scrolls a partly hidden message into view; measure after that scroll.
  await body.scrollIntoViewIfNeeded();
  const before = await layout();
  await body.hover();
  await expect(time).toBeHidden();
  await expect(time).toBeVisible();
  await expect(time).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect(await layout()).toEqual(before);
  const bounds = await message.evaluate((article) => {
    const time = article.querySelector(".message-time"),
      content = article.querySelector(".bubble, .tool-card"),
      previous =
        article.parentElement?.previousElementSibling?.querySelector(
          ".message",
        ),
      viewport = article.closest(".messages");
    if (!time || !content || !viewport) throw Error("message layout missing");
    const t = time.getBoundingClientRect(),
      c = content.getBoundingClientRect(),
      v = viewport.getBoundingClientRect();
    return {
      time: { top: t.top, bottom: t.bottom, left: t.left, right: t.right },
      content: { top: c.top },
      viewport: { top: v.top, left: v.left, right: v.right },
      previousBottom: previous?.getBoundingClientRect().bottom,
    };
  });
  expect(bounds.time.left).toBeGreaterThanOrEqual(bounds.viewport.left);
  expect(bounds.time.right).toBeLessThanOrEqual(bounds.viewport.right);
  expect(bounds.time.top).toBeGreaterThanOrEqual(bounds.viewport.top);
  expect(bounds.time.bottom).toBeLessThanOrEqual(bounds.content.top);
  if (bounds.previousBottom !== undefined)
    expect(bounds.time.top).toBeGreaterThanOrEqual(bounds.previousBottom + 4);
}
// Contract: actions use the context menu; full timestamps appear above a message only after a hover delay, without moving it or touching the previous message.
// Boundary: built renderer and real Store behind a fake bridge; Main's clipboard is covered by Electron specs.
test("messages keep context menu actions and delayed timestamp tooltips without hover toolbars", async ({
  renderer,
}, info) => {
  seedMessages(renderer.store());
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1050, height: 800 },
  });
  await page.locator(".bot-item").filter({ hasText: "时间布局" }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "停止回复", exact: true }),
  ).toHaveCount(0);
  const tool = page
    .locator(".message")
    .filter({ has: page.locator(".tool-card") });
  await timestampBounds(page.locator(".message.user"));
  await timestampBounds(page.locator(".message.assistant").first());
  await timestampBounds(tool);
  await page.screenshot({
    path: info.outputPath("collapsed-tool-time.png"),
    scale: "css",
  });
  await page.mouse.move(10, 10);
  await expect(tool.locator(".message-time")).toBeHidden();
  const message = page.locator(".message.assistant").last();
  const body = message.locator(".message-body");
  const menu = page.getByRole("dialog", { name: "消息操作", exact: true });
  await body.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: info.outputPath("message-context-menu.png"),
    scale: "css",
  });
  await menu.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => renderer.copied.at(-1)).toBe("处理完成");
  await expect(body).toBeFocused();
  await body.press("Shift+F10");
  await menu
    .getByRole("menuitem", { name: "复制请求 ID", exact: true })
    .click();
  await expect.poll(() => renderer.copied.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
  await body.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "回复", exact: true }).click();
  await expect(page.getByRole("region", { name: "引用回复" })).toContainText(
    "处理完成",
  );
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeFocused();
  await body.click({ button: "right" });
  await menu.getByRole("button", { name: "回应 👍", exact: true }).click();
  await expect(
    message.getByRole("button", { name: "👍 1", exact: true }),
  ).toBeVisible();
  await body.click({ button: "right" });
  await menu.getByRole("button", { name: "更多表情", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "更多表情", exact: true });
  await picker.getByRole("textbox", { name: "搜索表情符号" }).fill("火箭");
  await picker.getByRole("button", { name: "回应 🚀", exact: true }).click();
  await expect(
    message.getByRole("button", { name: "🚀 1", exact: true }),
  ).toBeVisible();
  await tool.getByRole("button", { name: /执行命令/ }).click();
  await expect(tool.getByRole("button", { name: /执行命令/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(tool.getByLabel("命令输出")).toBeVisible();
  await timestampBounds(tool);
  await page.screenshot({
    path: info.outputPath("expanded-tool-time.png"),
    scale: "css",
  });
  await tool.getByRole("button", { name: /执行命令/ }).click();
  await page.locator(".conversation-title").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 850, height: 750 });
  await expect(page.locator(".with-details")).toBeVisible();
  await timestampBounds(page.locator(".message.user"));
  await timestampBounds(tool);
  await page.screenshot({
    path: info.outputPath("compact-tool-time.png"),
    scale: "css",
  });
  await tool
    .getByRole("button", { name: /执行命令/ })
    .click({ button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => renderer.copied.at(-1)).toContain("echo timestamp");
  await page.locator(".message.user .message-body").press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".message.user .message-body")).toBeFocused();
  expect(renderer.unhandled).toEqual([]);
});
