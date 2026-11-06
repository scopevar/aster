import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAppDataDirectory } from "../src/platform/app-data-directory.js";

await test(
  "installed app data directory ignores the launching directory",
  { skip: process.platform === "win32" },
  () => {
    assert.equal(
      resolveAppDataDirectory({
        configured: undefined,
        packaged: true,
        home: "/home/xiaomi",
        xdgDataHome: undefined,
        cwd: "/home/xiaomi/main",
      }),
      "/home/xiaomi/.local/share/aster",
    );
    assert.equal(
      resolveAppDataDirectory({
        configured: undefined,
        packaged: true,
        home: "/home/xiaomi",
        xdgDataHome: "/home/xiaomi/data",
        cwd: "/home/xiaomi/main",
      }),
      "/home/xiaomi/data/aster",
    );
    assert.equal(
      resolveAppDataDirectory({
        configured: "/opt/data/aster",
        packaged: true,
        home: "/home/xiaomi",
        xdgDataHome: undefined,
        cwd: "/home/xiaomi/main",
      }),
      "/opt/data/aster",
    );
    assert.equal(
      resolveAppDataDirectory({
        configured: undefined,
        packaged: false,
        home: "/home/xiaomi",
        xdgDataHome: undefined,
        cwd: "/home/xiaomi/main",
      }),
      "/home/xiaomi/main/.runtime/aster",
    );
  },
);
