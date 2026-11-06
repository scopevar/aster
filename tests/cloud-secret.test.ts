import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aesSecretBox,
  defaultSecretBox,
  safeStorageSecretBox,
} from "../src/security/secret.js";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aster-secret-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withElectronBin(script: string, run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aster-electron-fake-"));
  const binary = join(directory, "electron");
  const previous = {
    PATH: process.env.PATH,
    ASTER_ELECTRON_BIN: process.env.ASTER_ELECTRON_BIN,
    ASTER_ELECTRON_APP: process.env.ASTER_ELECTRON_APP,
    ASTER_CLOUD_SECRET_KEY: process.env.ASTER_CLOUD_SECRET_KEY,
  };
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  process.env.ASTER_ELECTRON_BIN = binary;
  delete process.env.ASTER_ELECTRON_APP;
  delete process.env.ASTER_CLOUD_SECRET_KEY;
  try {
    await run();
  } finally {
    if (previous.ASTER_ELECTRON_BIN === undefined)
      delete process.env.ASTER_ELECTRON_BIN;
    else process.env.ASTER_ELECTRON_BIN = previous.ASTER_ELECTRON_BIN;
    if (previous.ASTER_ELECTRON_APP === undefined)
      delete process.env.ASTER_ELECTRON_APP;
    else process.env.ASTER_ELECTRON_APP = previous.ASTER_ELECTRON_APP;
    if (previous.ASTER_CLOUD_SECRET_KEY === undefined)
      delete process.env.ASTER_CLOUD_SECRET_KEY;
    else process.env.ASTER_CLOUD_SECRET_KEY = previous.ASTER_CLOUD_SECRET_KEY;
    process.env.PATH = previous.PATH;
    await rm(directory, { recursive: true, force: true });
  }
}

const plainFallback = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
if (process.env.ASTER_ARGV_LOG)
  writeFileSync(process.env.ASTER_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.ASTER_SAFE_STORAGE_PLAIN !== "1") process.exit(3);
const input = readFileSync(process.env.ASTER_SAFE_STORAGE_IN);
if (process.env.ASTER_SAFE_STORAGE_MODE === "seal") {
  writeFileSync(process.env.ASTER_SAFE_STORAGE_OUT, Buffer.concat([Buffer.from("E1"), input]));
} else {
  if (input.subarray(0, 2).toString() !== "E1") process.exit(1);
  writeFileSync(process.env.ASTER_SAFE_STORAGE_OUT, input.subarray(2));
}
process.exit(0);
`;

function argvRecord(json: string) {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("启动参数记录无效。");
  const args: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") throw new Error("启动参数记录无效。");
    args.push(item);
  }
  return args;
}

await test("opening existing ciphertext never creates a replacement wrapping key", async () => {
  await withTempDir(async (directory) => {
    const original = await aesSecretBox(Buffer.alloc(32, 7)).seal(
      Buffer.from("existing secret"),
    );
    const path = join(directory, "existing.sealed");
    await writeFile(path, original);
    let protectionCalls = 0;
    const box = safeStorageSecretBox(
      directory,
      async (_directory, _mode, payload) => {
        protectionCalls++;
        return payload;
      },
    );
    await assert.rejects(box.open(original), /缺少原始密钥/);
    assert.equal(protectionCalls, 0);
    await assert.rejects(readFile(join(directory, "os-crypt.key")), {
      code: "ENOENT",
    });
    assert.deepEqual(await readFile(path), original);
  });
});

await test("defaultSecretBox on Linux prefers ASTER_CLOUD_SECRET_KEY over safeStorage", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  await withTempDir(async (directory) => {
    const previous = process.env.ASTER_CLOUD_SECRET_KEY;
    process.env.ASTER_CLOUD_SECRET_KEY = "a".repeat(64);
    process.env.ASTER_ELECTRON_BIN = join(directory, "missing-electron");
    try {
      const box = defaultSecretBox(directory);
      const sealed = await box.seal(Buffer.from("payload"));
      const opened = await box.open(sealed);
      assert.equal(Buffer.from(opened).toString(), "payload");
    } finally {
      if (previous === undefined) delete process.env.ASTER_CLOUD_SECRET_KEY;
      else process.env.ASTER_CLOUD_SECRET_KEY = previous;
      delete process.env.ASTER_ELECTRON_BIN;
    }
  });
});

await test("legacy safeStorage preserves its key when the desktop keyring is unavailable", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  await withElectronBin(plainFallback, async () => {
    await withTempDir(async (directory) => {
      const plain = Buffer.from("persisted-secret");
      const first = safeStorageSecretBox(directory);
      const sealed = await first.seal(plain);
      assert.equal(
        Buffer.from(await first.open(sealed)).toString(),
        "persisted-secret",
      );
      const second = safeStorageSecretBox(directory);
      assert.equal(
        Buffer.from(await second.open(sealed)).toString(),
        "persisted-secret",
      );
    });
  });
});

await test("packaged electron is launched as the app, without the helper script path", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  await withElectronBin(plainFallback, async () => {
    await withTempDir(async (directory) => {
      const argvLog = join(directory, "argv.json");
      process.env.ASTER_ARGV_LOG = argvLog;
      try {
        await safeStorageSecretBox(directory).seal(
          Buffer.from("packaged-launch"),
        );
        const argv = argvRecord(await readFile(argvLog, "utf8"));
        assert.equal(
          argv.some((arg) => arg.includes("safe-storage-host")),
          false,
        );
        assert.equal(
          argv.some((arg) => arg.startsWith("--user-data-dir=")),
          true,
        );
      } finally {
        delete process.env.ASTER_ARGV_LOG;
      }
    });
  });
});

await test("dev electron is launched with the app directory", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  await withElectronBin(plainFallback, async () => {
    await withTempDir(async (directory) => {
      const appDir = join(directory, "app");
      const argvLog = join(directory, "argv.json");
      process.env.ASTER_ELECTRON_APP = appDir;
      process.env.ASTER_ARGV_LOG = argvLog;
      try {
        await safeStorageSecretBox(directory).seal(Buffer.from("dev-launch"));
        const argv = argvRecord(await readFile(argvLog, "utf8"));
        assert.equal(argv.includes(appDir), true);
        assert.equal(
          argv.some((arg) => arg.includes("safe-storage-host")),
          false,
        );
      } finally {
        delete process.env.ASTER_ELECTRON_APP;
        delete process.env.ASTER_ARGV_LOG;
      }
    });
  });
});

await test("desktop entry persists a key without opening the desktop", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  const previous = {
    ASTER_ELECTRON_BIN: process.env.ASTER_ELECTRON_BIN,
    ASTER_ELECTRON_APP: process.env.ASTER_ELECTRON_APP,
    ASTER_CLOUD_SECRET_KEY: process.env.ASTER_CLOUD_SECRET_KEY,
  };
  const root = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(join(root, "package.json"));
  const appDir = await mkdtemp(join(tmpdir(), "aster-entry-app-"));
  try {
    const electronDir = dirname(require.resolve("electron"));
    const relative = (
      await readFile(join(electronDir, "path.txt"), "utf8")
    ).trim();
    const binary = join(
      process.env.ELECTRON_OVERRIDE_DIST_PATH || join(electronDir, "dist"),
      relative,
    );
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({ main: "entry.cjs" }),
    );
    await writeFile(
      join(appDir, "entry.cjs"),
      await readFile(join(root, "src/desktop/entry.cjs")),
    );
    await writeFile(
      join(appDir, "safe-storage-host.cjs"),
      await readFile(join(root, "src/platform/safe-storage-host.cjs")),
    );
    delete process.env.ASTER_CLOUD_SECRET_KEY;
    process.env.ASTER_ELECTRON_BIN = binary;
    process.env.ASTER_ELECTRON_APP = appDir;
    await withTempDir(async (directory) => {
      const box = safeStorageSecretBox(directory);
      let sealed: Uint8Array;
      try {
        sealed = await box.seal(Buffer.from("entry-round-trip"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/main\.cjs|Cannot find module/.test(message)) throw error;
        t.skip(`Electron safeStorage is not usable here: ${message}`);
        return;
      }
      assert.equal(
        Buffer.from(await box.open(sealed)).toString(),
        "entry-round-trip",
      );
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "MODULE_NOT_FOUND" || error.code === "ENOENT")
    ) {
      t.skip("Electron program is not installed");
      return;
    }
    throw error;
  } finally {
    if (previous.ASTER_ELECTRON_BIN === undefined)
      delete process.env.ASTER_ELECTRON_BIN;
    else process.env.ASTER_ELECTRON_BIN = previous.ASTER_ELECTRON_BIN;
    if (previous.ASTER_ELECTRON_APP === undefined)
      delete process.env.ASTER_ELECTRON_APP;
    else process.env.ASTER_ELECTRON_APP = previous.ASTER_ELECTRON_APP;
    if (previous.ASTER_CLOUD_SECRET_KEY === undefined)
      delete process.env.ASTER_CLOUD_SECRET_KEY;
    else process.env.ASTER_CLOUD_SECRET_KEY = previous.ASTER_CLOUD_SECRET_KEY;
    await rm(appDir, { recursive: true, force: true });
  }
});

await test("legacy safeStorage reports a clear error when its helper cannot start", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  await withElectronBin("#!/bin/sh\nexit 1\n", async () => {
    await withTempDir(async (directory) => {
      const box = safeStorageSecretBox(directory);
      await assert.rejects(box.seal(Buffer.from("x")), /凭据保护|Electron/);
    });
  });
});

await test("legacy safeStorage round-trips through Electron", async (t) => {
  if (process.platform !== "linux") {
    t.skip("safeStorageSecretBox is Linux-only");
    return;
  }
  const previous = {
    ASTER_ELECTRON_BIN: process.env.ASTER_ELECTRON_BIN,
    ASTER_ELECTRON_APP: process.env.ASTER_ELECTRON_APP,
    ASTER_CLOUD_SECRET_KEY: process.env.ASTER_CLOUD_SECRET_KEY,
  };
  delete process.env.ASTER_ELECTRON_BIN;
  delete process.env.ASTER_ELECTRON_APP;
  delete process.env.ASTER_CLOUD_SECRET_KEY;
  try {
    await withTempDir(async (directory) => {
      const plain = Buffer.from("real-safe-storage-round-trip");
      const first = safeStorageSecretBox(directory);
      let sealed: Uint8Array;
      try {
        sealed = await first.seal(plain);
      } catch (error) {
        t.skip(
          `Electron safeStorage is not usable here: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      assert.equal(
        Buffer.from(await first.open(sealed)).toString(),
        plain.toString(),
      );
      const second = safeStorageSecretBox(directory);
      assert.equal(
        Buffer.from(await second.open(sealed)).toString(),
        plain.toString(),
      );
    });
  } finally {
    if (previous.ASTER_ELECTRON_BIN === undefined)
      delete process.env.ASTER_ELECTRON_BIN;
    else process.env.ASTER_ELECTRON_BIN = previous.ASTER_ELECTRON_BIN;
    if (previous.ASTER_ELECTRON_APP === undefined)
      delete process.env.ASTER_ELECTRON_APP;
    else process.env.ASTER_ELECTRON_APP = previous.ASTER_ELECTRON_APP;
    if (previous.ASTER_CLOUD_SECRET_KEY === undefined)
      delete process.env.ASTER_CLOUD_SECRET_KEY;
    else process.env.ASTER_CLOUD_SECRET_KEY = previous.ASTER_CLOUD_SECRET_KEY;
  }
});
