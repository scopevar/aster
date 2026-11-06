import { AppError } from "../../src/shared/core.js";
import type { DesktopPreferences } from "../../src/shared/desktop/preferences.js";
import { test, expect } from "../helpers/renderer-app.js";

const missingModel = "尚未配置模型，请在设置 → 模型与连接中添加供应商。";

// The real app menu, command queue and notification surface own this regression:
// operation errors must float above the page, remain repeatable, and never move the conversation.
test("operation errors appear in top-center toasts without moving the conversation", async ({
  renderer,
}, info) => {
  const page = await renderer.open({
    handlers: {
      command: () => {
        throw new AppError("unavailable", missingModel);
      },
    },
  });
  const conversation = page.getByRole("region", { name: "开始使用 Aster" });
  const notice = page
    .getByRole("region", { name: "通知", exact: true })
    .getByRole("alertdialog", { name: missingModel });
  await expect(conversation).toBeVisible();
  await expect(page.locator(".conversation").getByRole("alert")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [760, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      const before = await conversation.boundingBox();
      await page.screenshot({
        path: info.outputPath(`before-${colorScheme}-${width}.png`),
      });
      await page.getByRole("button", { name: /^应用菜单/ }).click();
      await page.getByRole("menuitem", { name: "检查 Agent 连接" }).click();
      await expect(page.getByText(missingModel, { exact: true })).toBeVisible();
      await expect(notice).toBeVisible();
      await notice.hover();
      await expect(
        page.locator(".conversation").getByRole("alert"),
      ).toHaveCount(0);
      expect(await conversation.boundingBox()).toEqual(before);
      const box = await notice.boundingBox();
      if (!box) throw Error("Missing toast layout");
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(1);
      expect(box.y).toBeGreaterThan(0);
      expect(box.y + box.height).toBeLessThan(800 / 4);
      await expect(notice).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath(`error-${colorScheme}-${width}.png`),
        animations: "disabled",
      });
      await notice.getByRole("button", { name: "关闭提示" }).click();
      await expect(notice).toHaveCount(0);
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await page.getByRole("menuitem", { name: "检查 Agent 连接" }).click();
    await expect(notice).toHaveCount(attempt + 1);
  }
  await notice.first().hover();
  await expect(notice.nth(1)).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("errors-expanded.png"),
    animations: "disabled",
  });
  await notice.first().getByRole("button", { name: "关闭提示" }).click();
  await expect(notice).toHaveCount(1);
  await notice.getByRole("button", { name: "关闭提示" }).click();
  await expect(notice).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});

// Existing success notifications also use the new provider; verify a real save,
// keyboard dismissal, and the automatic timeout after a later save.
test("settings success toasts support keyboard dismissal and automatic expiry", async ({
  renderer,
}, info) => {
  let preferences: DesktopPreferences = {
    version: 3,
    revision: 0,
    hardwareAcceleration: true,
    appliedHardwareAcceleration: true,
    timeZone: "auto",
    theme: "system",
    shortcut: null,
    shortcutStatus: { state: "disabled", detail: "" },
  };
  const page = await renderer.open({
    handlers: {
      preferences: () => preferences,
      savePreferences: (change) => {
        preferences = {
          ...preferences,
          hardwareAcceleration:
            change.hardwareAcceleration ?? preferences.hardwareAcceleration,
          revision: preferences.revision + 1,
        };
        return preferences;
      },
    },
  });
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const acceleration = page.getByRole("switch", { name: "使用硬件加速" });
  await expect(acceleration).toBeChecked();
  await acceleration.press("Space");
  await expect(acceleration).not.toBeChecked();
  const notice = page.getByRole("alertdialog", {
    name: "已保存，下次启动界面时生效",
  });
  await expect(notice).toBeVisible();
  await page.keyboard.press("Alt+KeyT");
  await expect(
    page.getByRole("region", { name: "通知", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notice).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notice.getByRole("button", { name: "关闭提示" })).toBeFocused();
  await page.screenshot({
    path: info.outputPath("success-keyboard.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Enter");
  await expect(notice).toHaveCount(0);
  await acceleration.press("Space");
  await expect(acceleration).toBeChecked();
  const saved = page.getByRole("alertdialog", {
    name: "已保存，当前界面已使用此设置",
  });
  await expect(saved).toBeVisible();
  await page.mouse.move(10, 100);
  await expect(saved).toHaveCount(0, { timeout: 7000 });
  expect(renderer.unhandled).toEqual([]);
});

test("backend connection errors remain visible until reconnection", async ({
  renderer,
}, info) => {
  const store = renderer.store();
  let offline = true;
  const page = await renderer.open({
    handlers: {
      snapshot: (query) => {
        if (offline) throw new AppError("unavailable", "后台连接暂时不可用");
        const snapshot = store.snapshotSince(query);
        return snapshot
          ? {
              changed: true,
              snapshot: {
                ...snapshot,
                capabilities: { agent: "ready", detail: "", accountType: null },
              },
            }
          : { changed: false, cursor: store.cursor() };
      },
    },
  });
  const status = page.locator(".conversation").getByRole("alert");
  await expect(status).toHaveText("后台连接暂时不可用");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("disconnected.png") });
  offline = false;
  await renderer.emit("workerSignal", {
    state: "live",
    cursor: store.cursor(),
  });
  await expect(status).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
