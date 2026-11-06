import assert from "node:assert/strict";
import { test, expect } from "../helpers/renderer-app.js";
import type { AppUpdateState } from "../../src/shared/desktop/app-update.js";

for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 1052, height: 769 },
    { width: 760, height: 550 },
  ]) {
    test(`updates explain waiting and cancellation in ${colorScheme} at ${size.width}px`, async ({
      renderer,
    }, info) => {
      let state: AppUpdateState = {
        enabled: true,
        status: "downloaded",
        channel: "latest",
        currentVersion: "0.0.1",
        availableVersion: "0.0.2",
        downloadedVersion: "0.0.2",
        downloadPercent: 100,
        message: null,
        disabledReason: null,
      };
      const page = await renderer.open({
        colorScheme,
        size,
        handlers: {
          appUpdate: async (request) => {
            if (request.action === "install")
              state = {
                ...state,
                status: "preparing",
                message:
                  "正在等待1 个会话或后台任务结束。可取消更新，继续使用。",
              };
            if (request.action === "cancel-install")
              state = {
                ...state,
                status: "downloaded",
                message: "更新已取消，后台恢复接收新任务。已下载的更新保留。",
              };
            return state;
          },
        },
      });
      await page.getByRole("button", { name: /^应用菜单/ }).click();
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      const settings = page.getByRole("region", { name: "设置", exact: true });
      await settings.getByRole("button", { name: "更新", exact: true }).click();
      const section = page.getByRole("region", {
        name: "应用更新",
        exact: true,
      });
      await expect(
        section.getByRole("button", { name: "安装并重启", exact: true }),
      ).toBeVisible();
      if (process.env.ASTER_UPDATE_BEFORE === "1") {
        await page.screenshot({ path: info.outputPath("before.png") });
        return;
      }
      await expect(section).toContainText("下载不影响任务");
      await expect(section).toContainText("排队任务在重启后继续");
      await page.screenshot({ path: info.outputPath("downloaded.png") });
      await section
        .getByRole("button", { name: "安装并重启", exact: true })
        .click();
      await expect(section).toContainText("正在等待1 个会话或后台任务结束");
      const cancel = section.getByRole("button", {
        name: "取消更新",
        exact: true,
      });
      await expect(cancel).toBeEnabled();
      await page.screenshot({ path: info.outputPath("waiting.png") });
      const fits = await section.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      );
      expect(fits).toBe(true);
      await cancel.click();
      await expect(section).toContainText("后台恢复接收新任务");
      await expect(
        section.getByRole("button", { name: "安装并重启", exact: true }),
      ).toBeEnabled();
      await page.screenshot({ path: info.outputPath("cancelled.png") });
      state = {
        ...state,
        status: "installing",
        message: "正在停止后台并安装更新，即将重启…",
      };
      await renderer.emit("appUpdate", state);
      await expect(
        section.getByRole("button", { name: "安装并重启中…", exact: true }),
      ).toBeDisabled();
      assert.deepEqual(renderer.unhandled, []);
    });
  }
}
