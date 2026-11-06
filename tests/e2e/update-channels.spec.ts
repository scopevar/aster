import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { openDesktop } from "../helpers/local-desktop.js";
import { selectSetting } from "../helpers/settings-controls.js";
import { readPackage } from "../../src/release/release-git.js";
import { parseVersion } from "../../src/release/version.js";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";

// Real settings -> IPC -> electron-updater -> HTTP. The server controls only
// published metadata; no update client or channel routing is mocked.
test("update channel selection requests isolated feeds and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-update-channels-"));
  const requests: string[] = [];
  const currentVersion = (await readPackage(resolve("."))).data.version;
  const { major, minor, patch } = parseVersion(currentVersion);
  const nightlyVersion = `${major}.${minor}.${patch + 1}-nightly.20261028.1`;
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    requests.push(path);
    const nightly = path.startsWith("/updates/nightly/nightly");
    if (!nightly && !path.startsWith("/updates/stable/latest")) {
      response.writeHead(404).end();
      return;
    }
    const version = nightly ? nightlyVersion : currentVersion;
    const file = `aster-${version}-x64.exe`;
    response.end(
      stringify({
        version,
        files: [
          {
            url: `${version}/${file}`,
            size: 128,
            sha512: Buffer.alloc(64, 42).toString("base64"),
          },
        ],
        releaseDate: "2026-10-28T00:00:00Z",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing update test server");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  Object.assign(env, {
    ASTER_DATA_DIR: directory,
    ASTER_FORCE_DEV_UPDATE: "1",
    ASTER_DISABLE_AUTO_UPDATE: "0",
    ASTER_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/stable/`,
    APPIMAGE: join(directory, "fixture.AppImage"),
  });
  let app;
  try {
    app = await electron.launch({
      args: [resolve(".")],
      chromiumSandbox: true,
      env,
    });
    const page = await openDesktop(app);
    await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "更新", exact: true }).click();
    const channel = settings.getByRole("button", {
      name: /更新通道$/,
      exact: true,
    });
    await expect(channel).toHaveText("稳定");
    await settings
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    await expect
      .poll(() =>
        requests.some((path) => path.startsWith("/updates/stable/latest")),
      )
      .toBe(true);
    await expect(channel).toBeEnabled();
    await selectSetting(page, "更新通道", "Nightly");
    await expect
      .poll(() =>
        requests.some((path) => path.startsWith("/updates/nightly/nightly")),
      )
      .toBe(true);
    await expect(
      settings.getByRole("button", { name: "下载更新", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("nightly.png"),
      scale: "css",
    });
    await selectSetting(page, "更新通道", "稳定");
    await expect(
      settings.getByRole("button", { name: "检查更新", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("stable.png"),
      scale: "css",
    });
    await selectSetting(page, "更新通道", "Nightly");
    await expect(channel).toBeEnabled();
    await app.close();
    app = await electron.launch({
      args: [resolve(".")],
      chromiumSandbox: true,
      env,
    });
    const restored = await app.firstWindow();
    await restored
      .getByRole("button", { name: /^应用菜单/, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "设置", exact: true }).click();
    await restored
      .getByRole("region", { name: "设置", exact: true })
      .getByRole("button", { name: "更新", exact: true })
      .click();
    await expect(
      restored.getByRole("button", { name: /更新通道$/, exact: true }),
    ).toHaveText("Nightly");
    requests.length = 0;
    await restored
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    await expect(
      restored.getByRole("button", { name: "下载更新", exact: true }),
    ).toBeVisible();
    expect(
      requests.every((path) => path.startsWith("/updates/nightly/nightly")),
    ).toBe(true);
    await restored.emulateMedia({ colorScheme: "dark" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(900, 680),
    );
    const section = restored.getByRole("region", {
      name: "应用更新",
      exact: true,
    });
    await expect(section).toBeInViewport();
    expect(
      await restored.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await restored.screenshot({
      path: test.info().outputPath("nightly-dark-compact.png"),
      scale: "css",
    });
  } finally {
    await app?.close();
    if (await daemonStatus(directory)) await stopDaemon(directory);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 200,
    });
  }
});
