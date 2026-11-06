import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";
import { readPackage } from "../../src/release/release-git.js";
import { parseVersion } from "../../src/release/version.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { selectSetting } from "../helpers/settings-controls.js";

// Real Main, IPC and electron-updater. Electron redirects only GitHub HTTP traffic
// to the local release server, which supplies Atom and channel-specific manifests.
test("GitHub releases isolate stable and Nightly updates and restore the selected channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-github-updates-"));
  const requests: string[] = [];
  const currentVersion = (await readPackage(resolve("."))).data.version;
  const { major, minor, patch } = parseVersion(currentVersion);
  const nightlyVersion = `${major}.${minor}.${patch + 1}-nightly.20261101.1`;
  const base = "/scopevar/aster/releases";
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    requests.push(path);
    if (path === `${base}.atom`) {
      const entries = [nightlyVersion, currentVersion].map(
        (version) =>
          `<entry><id>v${version}</id><title>${version}</title><link href="https://github.com${base}/tag/v${version}"/><updated>2026-11-01T00:00:00Z</updated><content type="html">release</content></entry>`,
      );
      response.setHeader("Content-Type", "application/atom+xml");
      response.end(
        `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`,
      );
      return;
    }
    if (path === `${base}/latest`) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ tag_name: `v${currentVersion}` }));
      return;
    }
    const nightly = path.startsWith(
      `${base}/download/v${nightlyVersion}/nightly`,
    );
    if (
      !nightly &&
      !path.startsWith(`${base}/download/v${currentVersion}/latest`)
    ) {
      response.writeHead(404).end();
      return;
    }
    const version = nightly ? nightlyVersion : currentVersion;
    const extension = process.platform === "win32" ? "exe" : "AppImage";
    response.end(
      stringify({
        version,
        files: [
          {
            url: `aster-${version}-x64.${extension}`,
            size: 128,
            sha512: Buffer.alloc(64, 42).toString("base64"),
            ...(extension === "AppImage" ? { blockMapSize: 8 } : {}),
          },
        ],
        releaseDate: "2026-11-01T00:00:00Z",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing release server");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  Object.assign(env, {
    ASTER_DATA_DIR: directory,
    ASTER_FORCE_DEV_UPDATE: "1",
    ASTER_DISABLE_AUTO_UPDATE: "0",
    ASTER_UPDATE_REPOSITORY: "scopevar/aster",
    ASTER_UPDATE_URL: "",
    APPIMAGE: join(directory, "fixture.AppImage"),
  });
  let app;
  const launch = async () => {
    const desktop = await electron.launch({
      args: [resolve(".")],
      chromiumSandbox: true,
      env,
    });
    await desktop.evaluate(({ session }, target) => {
      session
        .fromPartition("electron-updater")
        .webRequest.onBeforeRequest(
          { urls: ["https://github.com/scopevar/aster/releases*"] },
          (details, callback) => {
            const url = new URL(details.url);
            callback({ redirectURL: target + url.pathname + url.search });
          },
        );
    }, origin);
    return desktop;
  };
  try {
    app = await launch();
    const page = await openDesktop(app);
    await page.getByRole("button", { name: /^应用菜单/, exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "更新", exact: true }).click();
    await settings
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    await expect
      .poll(() => requests.join("\n"))
      .toContain(`/v${currentVersion}/latest`);
    expect(requests.some((path) => path.includes(`/v${nightlyVersion}/`))).toBe(
      false,
    );
    await selectSetting(page, "更新通道", "Nightly");
    await expect(
      settings.getByRole("button", { name: "下载更新", exact: true }),
    ).toBeVisible();
    expect(
      requests.some((path) => path.includes(`/v${nightlyVersion}/nightly`)),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("github-nightly.png"),
      scale: "css",
    });
    await app.close();
    app = await launch();
    const restored = await openDesktop(app);
    await restored
      .getByRole("button", { name: /^应用菜单/, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "设置", exact: true }).click();
    const restoredSettings = restored.getByRole("region", {
      name: "设置",
      exact: true,
    });
    await restoredSettings
      .getByRole("button", { name: "更新", exact: true })
      .click();
    await expect(
      restored.getByRole("button", { name: /更新通道$/, exact: true }),
    ).toHaveText("Nightly");
    requests.length = 0;
    await restoredSettings
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    await expect(
      restoredSettings.getByRole("button", { name: "下载更新", exact: true }),
    ).toBeVisible();
    expect(
      requests.some((path) => path.includes(`/v${currentVersion}/latest`)),
    ).toBe(false);
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
