import { test, expect } from "../helpers/renderer-app.js";
import { newBot, openStartConversation } from "../e2e/new-conversation.js";

// Contract: the picker keeps usable spacing and supports search, keyboard selection and dismissal.
// Regression: the input touches the dialog edges; selecting a Bot opens a blank chat using its Bot ID.
// Gap: existing picker assertions only cover visibility and closing, not layout or selection.
// Boundary: built Renderer and real Store; pointer entry leaves focus on the dialog, with normal keyboard access to search.
test("conversation picker supports spacious search and keyboard selection", async ({
  renderer,
}, info) => {
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1050, height: 768 },
  });
  const picker = page.getByRole("dialog", { name: "新建会话", exact: true });
  await expect(
    page.getByRole("region", { name: "开始使用 Aster" }),
  ).toBeVisible();
  for (const name of ["研究助手", "生活助手"]) {
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill(name);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await openStartConversation(page);
  const search = picker.getByLabel("搜索会话", { exact: true });
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    picker.getByRole("button", { name: "关闭弹窗", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.screenshot({
    path: info.outputPath("picker-light.png"),
    scale: "css",
    animations: "disabled",
  });
  const dialogBounds = await picker.boundingBox();
  const searchBounds = await search.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(searchBounds).not.toBeNull();
  expect(searchBounds!.x - dialogBounds!.x).toBeGreaterThanOrEqual(20);
  expect(searchBounds!.height).toBeGreaterThanOrEqual(36);
  expect(
    (await picker.getByRole("option").first().boundingBox())?.height,
  ).toBeGreaterThanOrEqual(56);

  await search.fill("不存在的会话");
  await expect(picker.getByRole("option")).toHaveCount(0);
  await expect(picker.getByRole("status")).toContainText("没有匹配的会话");
  await search.fill("研究");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".conversation-title")).toHaveText("研究助手");

  await openStartConversation(page);
  await search.fill("助手");
  await picker.getByRole("button", { name: "清空搜索" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  const secondName = await picker
    .getByRole("option")
    .nth(1)
    .getAttribute("aria-label");
  await search.press("Tab");
  await expect(picker.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".conversation-title")).toHaveText(secondName!);

  await openStartConversation(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 760, height: 550 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(picker).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("picker-dark-compact.png"),
    scale: "css",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await openStartConversation(page);
  await picker.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(picker).toHaveCount(0);
  await openStartConversation(page);
  await picker.getByRole("option", { name: "研究助手", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".conversation-title")).toHaveText("研究助手");
  await openStartConversation(page);
  await page.mouse.click(10, 200);
  await expect(picker).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
