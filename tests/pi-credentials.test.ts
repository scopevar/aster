import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiCredentials } from "../src/agent/pi-credentials.js";
import { ownDirectory } from "../src/platform/directory-lease.js";

await test("cancelled credential changes never replace the saved account", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-pi-auth-cancel-"));
  try {
    const credentials = new PiCredentials(home);
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "original-key",
    }));
    const controller = new AbortController();
    await assert.rejects(
      credentials.modify(
        "openai",
        async () => {
          controller.abort();
          return { type: "api_key", key: "cancelled-key" };
        },
        { signal: controller.signal },
      ),
      { name: "AbortError" },
    );
    const saved = await credentials.read("openai");
    assert.ok(saved?.type === "api_key");
    assert.equal(saved.key, "original-key");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("Pi credentials use encrypted storage, serialized mutations and secret-free metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-pi-auth-"));
  try {
    const first = new PiCredentials(home),
      second = new PiCredentials(home);
    await first.modify("test", async () => ({
      type: "api_key",
      key: "private-fixture-key",
    }));
    assert.equal(
      (await readFile(join(home, "pi-auth.sealed"))).includes(
        Buffer.from("private-fixture-key"),
      ),
      false,
    );
    assert.deepEqual(await second.list(), [
      { providerId: "test", type: "api_key" },
    ]);
    const scoped = await first.scoped("test", AbortSignal.timeout(30000));
    await second.modify("test", async () => ({
      type: "api_key",
      key: "replacement-account-key",
    }));
    const pinned = await scoped.read("test");
    assert.ok(pinned?.type === "api_key");
    assert.equal(pinned.key, "private-fixture-key");
    const replacement = await first.read("test");
    assert.ok(replacement?.type === "api_key");
    assert.equal(replacement.key, "replacement-account-key");
    assert.equal(await scoped.read("other"), undefined);
    await scoped.close();
    await assert.rejects(scoped.read("test"), /范围已结束/);
    await Promise.all([
      first.modify("other", async () => ({
        type: "api_key",
        key: "second-key",
      })),
      second.modify("third", async () => ({
        type: "api_key",
        key: "third-key",
      })),
    ]);
    assert.equal((await first.list()).length, 3);
    const updating = await first.scoped("third", AbortSignal.timeout(30000));
    let finishUpdate: () => void = () => {},
      started: () => void = () => {};
    const gate = new Promise<void>((accept) => {
      finishUpdate = accept;
    });
    const began = new Promise<void>((accept) => {
      started = accept;
    });
    const mutation = updating.modify("third", async () => {
      started();
      await gate;
      return { type: "api_key", key: "updated-third-key" };
    });
    await began;
    let drained = false;
    const closing = updating.close().then(() => {
      drained = true;
    });
    await new Promise<void>((accept) => setImmediate(accept));
    assert.equal(
      drained,
      false,
      "closing must await the accepted credential update",
    );
    finishUpdate();
    await mutation;
    await closing;
    const refreshed = await first.read("third");
    assert.ok(refreshed?.type === "api_key");
    assert.equal(refreshed.key, "updated-third-key");
    const lease = await ownDirectory(home, "pi-auth");
    try {
      await assert.rejects(second.delete("test"), /EADDRINUSE/);
      assert.equal((await first.read("test"))?.type, "api_key");
    } finally {
      await lease.close();
    }
    await first.delete("test");
    assert.equal(await second.read("test"), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
