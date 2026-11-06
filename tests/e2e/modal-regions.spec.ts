import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { data } from "./ipc-result.js";

// Owner: Electron's OS-facing drag-region boundary. CDP clicks can pass even when
// the native frame consumes mouse input, so also verify the overlapping modal
// is explicitly excluded from dragging. Renderer tests cover its hover styling.
async function excludesBackgroundDrag(page: Page, dialog: Locator) {
  const close = dialog.getByRole("button", { name: "关闭弹窗", exact: true });
  const button = await close.boundingBox();
  const background = await page
    .locator(".conversation-header .drag-region")
    .boundingBox();
  if (!button || !background) throw Error("Missing overlapping window regions");
  expect(button.x).toBeLessThan(background.x + background.width);
  expect(button.x + button.width).toBeGreaterThan(background.x);
  expect(button.y).toBeLessThan(background.y + background.height);
  expect(button.y + button.height).toBeGreaterThan(background.y);
  await expect
    .poll(() =>
      dialog.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    )
    .toBe("no-drag");
  return close;
}

test("large local market and nested template dialogs keep close controls out of window drag regions", async ({
  desktop,
}, info) => {
  const app = await desktop.launch();
  const page = await openDesktop(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1120, 780);
  });
  const bot = data(
    await page.evaluate(() =>
      window.aster.command({
        id: crypto.randomUUID(),
        command: { type: "bot.create", name: "关闭按钮验收", description: "" },
      }),
    ),
  );
  if (!bot.id) throw Error("Missing fixture Bot");
  data(
    await page.evaluate(
      (botId) =>
        window.aster.command({
          id: crypto.randomUUID(),
          command: {
            type: "template.create",
            botId,
            includeSkills: false,
            includeRoutines: false,
          },
        }),
      bot.id,
    ),
  );
  await page.getByRole("button", { name: "本地市场", exact: true }).click();
  const market = page.getByRole("dialog", { name: "本地市场", exact: true });
  await page.screenshot({ path: info.outputPath("market-close-region.png") });
  const closeMarket = await excludesBackgroundDrag(page, market);
  await closeMarket.click();
  await expect(market).toHaveCount(0);
  await page.getByRole("button", { name: "本地市场", exact: true }).click();
  await market.getByRole("tab", { name: "模板", exact: true }).click();
  await market
    .getByRole("button", { name: "编辑模板 关闭按钮验收", exact: true })
    .click();
  const template = page.getByRole("dialog", { name: "本地模板", exact: true });
  await expect(template.getByLabel("模板名称", { exact: true })).toHaveValue(
    "关闭按钮验收",
  );
  const closeTemplate = await excludesBackgroundDrag(page, template);
  await closeTemplate.hover();
  await page.screenshot({ path: info.outputPath("template-close-hover.png") });
  await closeTemplate.click();
  await expect(template).toHaveCount(0);
  await expect(market).toBeVisible();
  await closeMarket.hover();
  await page.screenshot({ path: info.outputPath("market-close-hover.png") });
  await closeMarket.click();
  await expect(market).toHaveCount(0);
  expect(app.windows()).toHaveLength(1);
  await expect(page.getByRole("banner", { name: "应用标题栏" })).toBeVisible();
});
