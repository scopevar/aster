import type { Page } from "@playwright/test";
import { AppError } from "../../src/shared/core.js";
import type { AppUpdateState } from "../../src/shared/desktop/app-update.js";
import { test, expect } from "../helpers/renderer-app.js";

const updateState: AppUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "latest",
  currentVersion: "1.2.3",
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  message: null,
  disabledReason: "Local fixture",
};

async function openApplicationInfo(page: Page) {
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "关于 Aster", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("region", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "应用信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return settings.getByRole("main", { name: "应用信息", exact: true });
}

// The settings page owns local version metadata and the bundled license reader.
// The former dialog coverage did not protect settings navigation, discoverability,
// or keeping the long notice readable without a nested modal.
test("application information and complete licenses live inside settings across compact themes", async ({
  renderer,
}, info) => {
  const page = await renderer.open({
    colorScheme: "light",
    size: { width: 1050, height: 768 },
    handlers: {
      appUpdate: (request) => {
        if (request.action !== "state")
          throw new AppError(
            "unauthorized",
            "Only local metadata may be read.",
          );
        return updateState;
      },
    },
  });
  let licenseReads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/THIRD_PARTY_LICENSES.txt")) licenseReads++;
  });
  const panel = await openApplicationInfo(page);
  const settings = page.getByRole("region", { name: "设置", exact: true });
  const title = panel.getByRole("heading", { name: "Aster", exact: true });
  const licensing = panel.getByRole("button", {
    name: "第三方许可",
    exact: true,
  });
  const notice = panel.getByLabel("第三方许可正文");
  await expect(
    panel.getByText("本地版 · v1.2.3", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("© 2026 scopevar · GPL-3.0-only")).toBeVisible();
  expect(licenseReads).toBe(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [
      { width: 1050, height: 768 },
      { width: 760, height: 550 },
    ]) {
      await page.setViewportSize(size);
      await expect(title).toBeInViewport({ ratio: 1 });
      await expect(licensing).toBeInViewport({ ratio: 1 });
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `application-info-${colorScheme}-${size.width}.png`,
        ),
      });
    }
    await licensing.click();
    await expect(licensing).toHaveAttribute("aria-expanded", "true");
    await expect(licensing).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(notice).toBeFocused();
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice).toContainText("Permission is hereby granted");
    await expect(notice).toContainText("Mario Zechner");
    await expect(
      settings.getByRole("button", { name: "返回应用", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await notice.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await notice.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`application-licenses-${colorScheme}.png`),
    });
    await notice.press("Control+End");
    await expect
      .poll(() => notice.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(notice).toContainText("LGPL-2.1-only");
    await licensing.click();
    await expect(licensing).toHaveAttribute("aria-expanded", "false");
  }
  await settings.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page
    .getByRole("combobox", { name: "搜索", exact: true })
    .fill("第三方许可");
  await page.getByRole("option", { name: /^设置：应用信息/ }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});

test("unreadable license data reports a failure and retries the bundled artifact from settings", async ({
  renderer,
}) => {
  const page = await renderer.open({
    handlers: { appUpdate: () => updateState },
  });
  await page.route("**/THIRD_PARTY_LICENSES.txt", (route) =>
    route.fulfill({ status: 404, body: "File unavailable" }),
  );
  const panel = await openApplicationInfo(page);
  await panel.getByRole("button", { name: "第三方许可", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("许可声明读取失败。");
  await page.unroute("**/THIRD_PARTY_LICENSES.txt");
  await panel.getByRole("button", { name: "重试", exact: true }).click();
  await expect(panel.getByLabel("第三方许可正文")).toBeVisible();
  expect(renderer.unhandled).toEqual([]);
});

test("missing version metadata stays explicit without blocking license access", async ({
  renderer,
}) => {
  const page = await renderer.open({
    handlers: {
      appUpdate: () => {
        throw new AppError("unavailable", "Local metadata unavailable");
      },
    },
  });
  const panel = await openApplicationInfo(page);
  await expect(
    panel.getByText("版本信息暂不可用", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Aster", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "第三方许可", exact: true }).click();
  await expect(panel.getByLabel("第三方许可正文")).toBeVisible();
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
