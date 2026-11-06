import { test, expect } from "../helpers/renderer-app.js";
import { randomUUID } from "node:crypto";

test.beforeEach(({ renderer }) => {
  renderer.store().execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "已有助手", description: "" },
  });
});

// Real toolbar and settings navigation: mouse focus must not recolor the search
// border, menus must dismiss on outside clicks, and settings must not autofocus
// a return action. The market tests only covered opening the menu and Escape.
test("search keeps its border after mouse dismissal and retains keyboard focus indication", async ({
  renderer,
}, info) => {
  const page = await renderer.open();
  const search = page.getByRole("button", { name: "搜索会话和操作" });
  const add = page.getByRole("button", { name: "添加", exact: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator(":root")).toHaveAttribute(
      "data-theme",
      colorScheme,
    );
    for (const width of [900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await add.click();
      await page.keyboard.press("Escape");
      const border = await search.evaluate(
        (element) => getComputedStyle(element).borderColor,
      );
      await search.click();
      const dialog = page.getByRole("dialog", { name: "搜索", exact: true });
      await expect(dialog).toBeVisible();
      await page.mouse.click(width - 20, 780);
      await expect(dialog).toHaveCount(0);
      await expect(search).toBeFocused();
      await page.locator(".sidebar-top").screenshot({
        path: info.outputPath(`search-${colorScheme}-${width}.png`),
      });
      await expect(search).toHaveCSS("border-color", border);
      const mouseShadow = await search.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(search).toBeFocused();
      await expect(search).not.toHaveCSS("box-shadow", mouseShadow);
      await page.locator(".sidebar-top").screenshot({
        path: info.outputPath(`search-keyboard-${colorScheme}-${width}.png`),
      });
    }
  }
  expect(renderer.unhandled).toEqual([]);
});

test("add menu closes on outside clicks and supports toggling and keyboard selection", async ({
  renderer,
}, info) => {
  const page = await renderer.open();
  const add = page.getByRole("button", { name: "添加", exact: true });
  const menu = page.getByRole("menu", { name: "添加", exact: true });
  await add.click();
  await expect(menu).toBeVisible();
  await page.locator(".sidebar").click({ position: { x: 20, y: 200 } });
  await page.screenshot({
    path: info.outputPath("menu-outside-click.png"),
    animations: "disabled",
  });
  await expect(menu).toHaveCount(0);
  await add.click();
  await expect(menu).toBeVisible();
  await add.click();
  await expect(menu).toHaveCount(0);
  await add.click();
  await page.getByRole("button", { name: "搜索会话和操作" }).click();
  await expect(menu).toHaveCount(0);
  const search = page.getByRole("dialog", { name: "搜索", exact: true });
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await add.click();
  await menu.getByRole("menuitem", { name: "新建 Bot" }).click();
  await expect(menu).toHaveCount(0);
  const createBot = page.getByRole("dialog", { name: "创建新 Bot" });
  await expect(createBot).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(createBot).toHaveCount(0);
  await add.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "新建会话" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(createBot).toBeVisible();
  expect(renderer.unhandled).toEqual([]);
});

test("opening settings from search focuses the page without selecting the return action", async ({
  renderer,
}, info) => {
  const page = await renderer.open({
    handlers: {
      appUpdate: () => ({
        enabled: false,
        status: "disabled",
        channel: "latest",
        currentVersion: "0.0.1",
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
        message: null,
        disabledReason: "更新源尚未配置。",
      }),
    },
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [900, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("button", { name: "搜索会话和操作" }).click();
      await page
        .getByRole("combobox", { name: "搜索", exact: true })
        .fill("更新");
      if (width === 900) await page.keyboard.press("Enter");
      else await page.getByRole("option", { name: "设置：更新 设置" }).click();
      const settings = page.getByRole("region", { name: "设置", exact: true });
      const back = settings.getByRole("button", { name: "返回应用" });
      await expect(settings).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`settings-${colorScheme}-${width}.png`),
      });
      await expect(back).not.toBeFocused();
      await expect(settings).toBeFocused();
      const inactiveShadow = await back.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      await page.keyboard.press("Tab");
      await expect(back).toBeFocused();
      await expect(back).not.toHaveCSS("box-shadow", inactiveShadow);
      await page.keyboard.press("Enter");
      await expect(settings).toHaveCount(0);
    }
  }
  expect(renderer.unhandled).toEqual([]);
});
