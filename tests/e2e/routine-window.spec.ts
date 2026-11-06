import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { newBot } from "./new-conversation.js";

test("conversation header opens routines in a separate movable window", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "routine-window-"));
  const worker = await startWorker(directory);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] => item[1] !== undefined,
    ),
  );
  env.ASTER_DATA_DIR = directory;
  const app = await electron.launch({ args: [resolve(".")], env });
  try {
    const page = await openDesktop(app);
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("任务窗口验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.locator(".conversation-title")).toHaveText(
      "任务窗口验收",
    );
    await expect(
      page.getByRole("button", { name: "查看并管理任务", exact: true }),
    ).toBeVisible();
    const routinePage = app.waitForEvent("window");
    const started = performance.now();
    await page
      .getByRole("button", { name: "查看并管理任务", exact: true })
      .click();
    const routines = await routinePage;
    const nativeWindow = await app.browserWindow(routines);
    await expect
      .poll(() => nativeWindow.evaluate((window) => window.isVisible()))
      .toBe(true);
    const visibleMs = Math.round(performance.now() - started);
    await expect(routines).toHaveURL(/\/routines\.html\?/);
    await expect(
      routines.getByText("例行任务", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      routines.getByLabel("任务名称", { exact: true }),
    ).toBeVisible();
    const timingPath = test.info().outputPath("window-open.json");
    await writeFile(
      timingPath,
      JSON.stringify({
        visibleMs,
        readyMs: Math.round(performance.now() - started),
      }),
    );
    await test.info().attach("routine-window-open", {
      path: timingPath,
      contentType: "application/json",
    });
    for (const colorScheme of ["light", "dark"] as const) {
      await routines.emulateMedia({ colorScheme });
      for (const size of [
        { width: 760, height: 700 },
        { width: 560, height: 480 },
      ]) {
        await nativeWindow.evaluate(
          (window, size) => window.setSize(size.width, size.height),
          size,
        );
        await expect(
          routines.getByLabel("任务名称", { exact: true }),
        ).toBeVisible();
        await expect(
          routines.getByRole("button", { name: "创建任务", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await routines.screenshot({
          path: test
            .info()
            .outputPath(`routines-${colorScheme}-${size.width}.png`),
          animations: "disabled",
        });
      }
    }
    await expect(
      page.getByRole("dialog", { name: "例行任务", exact: true }),
    ).toHaveCount(0);
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(2);
    await routines
      .getByRole("button", { name: "关闭窗口", exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(1);
    await expect(page.locator(".conversation-title")).toHaveText(
      "任务窗口验收",
    );
    const loadingWindow = app.waitForEvent("window");
    await page
      .getByRole("button", { name: "查看并管理任务", exact: true })
      .click();
    const loadingPage = await loadingWindow;
    const loadingNative = await app.browserWindow(loadingPage);
    await loadingNative.evaluate((window) => window.close());
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(1);
    await expect(
      page.getByRole("button", { name: "查看并管理任务", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".routine-window-error")).toHaveCount(0);
  } finally {
    await app.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
