import { test, expect } from "../helpers/renderer-app.js";
import { newBot } from "../e2e/new-conversation.js";

// Owner: the built renderer, including the stylesheet order from its real entry.
// A component creating its cascade layer before the reset erased selected
// backgrounds and produced nested focus outlines. Existing UI tests only
// checked navigation and form behavior, so these checks protect their appearance.
for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 760, height: 550 },
    { width: 1314, height: 963 },
  ]) {
    test(`${colorScheme} controls preserve states and boundaries at ${size.width}px`, async ({
      renderer,
    }, info) => {
      const page = await renderer.open({ colorScheme, size });
      const conversations = page.getByRole("button", {
        name: "会话",
        exact: true,
      });
      const market = page.getByRole("button", {
        name: "本地市场",
        exact: true,
      });
      const menu = page.getByRole("button", { name: /^应用菜单/ });
      await expect(conversations).toHaveAttribute("aria-current", "page");
      await page.mouse.move(size.width - 30, 100);
      await page.screenshot({
        path: info.outputPath("navigation.png"),
        animations: "disabled",
      });
      await expect
        .soft(conversations)
        .not.toHaveCSS(
          "background-color",
          await market.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
        );
      await expect
        .soft(market)
        .not.toHaveCSS(
          "color",
          await conversations.evaluate(
            (element) => getComputedStyle(element).color,
          ),
        );

      const idleShadow = await menu.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      await menu.click();
      const applicationMenu = page.getByRole("menu", {
        name: "应用",
        exact: true,
      });
      await expect(applicationMenu).toBeVisible();
      await page.mouse.click(size.width - 30, 100);
      await expect(applicationMenu).toHaveCount(0);
      await expect.soft(menu).toHaveCSS("box-shadow", idleShadow);
      await expect.soft(menu).toHaveCSS("outline-style", "none");
      await menu.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(market).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu).toBeFocused();
      await expect.soft(menu).not.toHaveCSS("box-shadow", idleShadow);
      await expect.soft(menu).toHaveCSS("outline-style", "none");
      await page.screenshot({
        path: info.outputPath("navigation-keyboard.png"),
        animations: "disabled",
      });

      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      const settings = page.getByRole("region", { name: "设置", exact: true });
      await expect(settings).toBeVisible();
      const general = settings.getByRole("button", {
        name: "通用",
        exact: true,
      });
      const shortcuts = settings.getByRole("button", {
        name: "快捷键",
        exact: true,
      });
      await page.mouse.move(size.width - 30, 100);
      await expect
        .soft(general)
        .not.toHaveCSS(
          "background-color",
          await shortcuts.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
        );
      const theme = settings.getByRole("button", { name: /主题$/ });
      await expect(theme).toBeEnabled();
      await expect
        .soft(theme)
        .not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect.soft(theme).toHaveCSS("border-top-style", "solid");
      await expect.soft(theme).not.toHaveCSS("border-top-width", "0px");
      await expect(theme).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath("settings.png"),
        animations: "disabled",
      });

      await theme.click();
      const popover = page.locator(".settings-select-popover");
      const selected = page.getByRole("option", {
        name: "跟随系统",
        exact: true,
      });
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect.soft(popover).toHaveCSS("border-top-style", "solid");
      await expect.soft(popover).not.toHaveCSS("border-top-width", "0px");
      await expect
        .soft(selected)
        .not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(popover).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath("theme-picker.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(theme).toBeFocused();

      const search = settings.getByRole("searchbox", { name: "搜索设置分类" });
      const searchGroup = settings.locator(".search-field__group");
      const idleSearchShadow = await searchGroup.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      const idleInputShadow = await search.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      await search.click();
      await expect(search).toBeFocused();
      await expect
        .soft(searchGroup)
        .not.toHaveCSS("box-shadow", idleSearchShadow);
      await expect.soft(search).toHaveCSS("outline-style", "none");
      await expect.soft(search).toHaveCSS("box-shadow", idleInputShadow);
      await page.screenshot({
        path: info.outputPath("settings-search.png"),
        animations: "disabled",
      });

      await settings.getByRole("button", { name: "返回应用" }).click();
      await newBot(page);
      const createBot = page.getByRole("dialog", { name: "创建新 Bot" });
      await createBot.getByLabel("名称", { exact: true }).fill("界面样式验收");
      await expect
        .soft(createBot.getByRole("button", { name: "创建 Bot", exact: true }))
        .not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.screenshot({
        path: info.outputPath("create-bot.png"),
        animations: "disabled",
      });
      expect(renderer.unhandled).toEqual([]);
    });
  }
}
