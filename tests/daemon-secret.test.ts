import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultSecretBox,
  safeStorageSecretBox,
} from "../src/security/secret.js";
import { migrateDaemonSecrets } from "../src/daemon/migrate-secrets.js";
import { ownDirectory } from "../src/platform/directory-lease.js";
import { DirectoryLeaseBusy } from "../src/platform/directory-lease.js";

await test("offline OS key rewrap preserves sealed data, rejects a live writer and preserves corrupt keys", async (t) => {
  if (process.platform !== "win32")
    return t.skip("Real Windows safeStorage acceptance");
  // Owner: actual Electron safeStorage/DPAPI and lease, without a model or credential mock.
  const directory = await mkdtemp(join(tmpdir(), "aster-daemon-secret-"));
  const previous = process.env.ASTER_STRICT_SECRETS;
  const previousElectron = process.env.ASTER_ELECTRON_BIN;
  process.env.ASTER_STRICT_SECRETS = "1";
  try {
    const sealed = await safeStorageSecretBox(directory).seal(
      Buffer.from("preserved-private-context"),
    );
    const sealedPath = join(directory, "context.sealed");
    await writeFile(sealedPath, sealed);
    const lease = await ownDirectory(directory, "worker");
    try {
      await assert.rejects(migrateDaemonSecrets(directory), DirectoryLeaseBusy);
    } finally {
      await lease.close();
    }
    // An old marker can survive an interrupted explicit rewrap. It must not reset the AES key.
    await writeFile(join(directory, "os-crypt.backend"), "plain");
    await assert.rejects(
      safeStorageSecretBox(directory).open(sealed),
      /显式迁移/,
    );
    assert.equal((await migrateDaemonSecrets(directory)).migrated, 1);
    assert.deepEqual(await readFile(sealedPath), Buffer.from(sealed));
    process.env.ASTER_ELECTRON_BIN = join(directory, "electron-not-installed");
    assert.equal(
      Buffer.from(await defaultSecretBox(directory).open(sealed)).toString(),
      "preserved-private-context",
    );
    await migrateDaemonSecrets(directory);
    assert.equal(
      Buffer.from(await defaultSecretBox(directory).open(sealed)).toString(),
      "preserved-private-context",
    );
    const corrupt = Buffer.from("invalid-old-key");
    await writeFile(join(directory, "os-crypt.key"), corrupt);
    await assert.rejects(migrateDaemonSecrets(directory));
    assert.deepEqual(await readFile(join(directory, "os-crypt.key")), corrupt);
    assert.deepEqual(await readFile(sealedPath), Buffer.from(sealed));
  } finally {
    if (previous === undefined) delete process.env.ASTER_STRICT_SECRETS;
    else process.env.ASTER_STRICT_SECRETS = previous;
    if (previousElectron === undefined) delete process.env.ASTER_ELECTRON_BIN;
    else process.env.ASTER_ELECTRON_BIN = previousElectron;
    await rm(directory, { recursive: true, force: true });
  }
});
