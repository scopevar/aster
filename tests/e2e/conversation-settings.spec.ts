import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentConnectionsConfigSchema } from "../../src/shared/agent-connections.js";
import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";

// Only Electron can prove the settings bridge reaches the independent daemon
// and that the saved choice survives restarting both controller and daemon.
test("cancelled-context preference persists through Main, preload and daemon restart", async ({
  desktop,
}, info) => {
  let app = await desktop.launch({ colorScheme: null });
  let page = await openDesktop(app);
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  let toggle = page.getByRole("switch", { name: "取消后保留本轮上下文" });
  await expect(toggle).toBeChecked();
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "light";
    BrowserWindow.getAllWindows()[0]?.setSize(1050, 850);
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("electron-context-on.png"),
    animations: "disabled",
  });
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  const saved = agentConnectionsConfigSchema.parse(
    JSON.parse(
      await readFile(
        join(desktop.directory, "agent", "pi-models.json"),
        "utf8",
      ),
    ),
  );
  expect(saved.retainCancelledContext).toBe(false);
  await page.screenshot({
    path: info.outputPath("electron-context-off.png"),
    animations: "disabled",
  });
  await desktop.stop();
  app = await desktop.launch({ colorScheme: null });
  page = await openDesktop(app);
  await page.getByRole("button", { name: /^应用菜单/ }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  toggle = page.getByRole("switch", { name: "取消后保留本轮上下文" });
  await expect(toggle).not.toBeChecked();
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "dark";
    BrowserWindow.getAllWindows()[0]?.setSize(900, 680);
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("electron-restarted-dark.png"),
    animations: "disabled",
  });
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
});
