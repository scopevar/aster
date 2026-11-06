import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopPreferenceStore } from "../src/desktop/native/preferences.js";

await test("desktop preferences commit atomically, reject stale writes, apply hardware only on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-preferences-"));
  const path = join(directory, "preferences.json");
  try {
    const store = new DesktopPreferenceStore(path);
    assert.equal(store.read().timeZone, "Asia/Shanghai");
    assert.equal(store.read().theme, "system");
    const attempts = await Promise.allSettled([
      store.save({
        revision: 0,
        timeZone: "UTC",
        hardwareAcceleration: false,
        theme: "dark",
      }),
      store.save({ revision: 0, timeZone: "Asia/Tokyo" }),
    ]);
    assert.equal(attempts[0]?.status, "fulfilled");
    assert.equal(attempts[1]?.status, "rejected");
    assert.equal(store.read().timeZone, "UTC");
    assert.equal(store.read().appliedHardwareAcceleration, true);
    assert.equal(store.read().hardwareAcceleration, false);
    const committed = await readFile(path, "utf8");
    assert.equal(
      (await store.save({ revision: 1, theme: "dark" })).revision,
      1,
    );
    assert.equal(await readFile(path, "utf8"), committed);
    await assert.rejects(
      store.save({ revision: 0, theme: "dark" }),
      /设置已发生变化/,
    );
    assert.throws(() =>
      store.save({ revision: 1, timeZone: "invalid/timezone" }),
    );
    await store.close();
    await assert.rejects(store.save({ revision: 1, timeZone: "auto" }), /退出/);
    const restarted = new DesktopPreferenceStore(path);
    assert.equal(restarted.read().appliedHardwareAcceleration, false);
    assert.equal(restarted.read().revision, 1);
    assert.equal(restarted.read().theme, "dark");
    assert.deepEqual(await readdir(directory), ["preferences.json"]);
    await restarted.close();
    const corrupted = '{"version":999}';
    await writeFile(path, corrupted);
    assert.throws(() => new DesktopPreferenceStore(path), /原文件已保留/);
    assert.equal(await readFile(path, "utf8"), corrupted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("legacy preferences preserve appearance and data until a successful explicit save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-theme-migration-"));
  const path = join(directory, "preferences.json");
  const legacy = JSON.stringify({
    version: 1,
    revision: 7,
    hardwareAcceleration: false,
    timeZone: "Asia/Shanghai",
  });
  try {
    await writeFile(path, legacy);
    const store = new DesktopPreferenceStore(path);
    assert.equal(store.read().theme, "light");
    assert.equal(store.read().version, 3);
    assert.equal(store.read().revision, 7);
    assert.equal(store.read().timeZone, "Asia/Shanghai");
    assert.equal(store.read().hardwareAcceleration, false);
    assert.equal(await readFile(path, "utf8"), legacy);
    await store.save({ revision: 7, theme: "dark" });
    await store.close();
    const restarted = new DesktopPreferenceStore(path);
    assert.equal(restarted.read().theme, "dark");
    assert.equal(restarted.read().revision, 8);
    assert.equal(restarted.read().timeZone, "Asia/Shanghai");
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("legacy remote-only preferences preserve local settings while retiring remote control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-local-preferences-"));
  const path = join(directory, "preferences.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        revision: 7,
        hardwareAcceleration: false,
        timeZone: "UTC",
        theme: "dark",
        shortcut: null,
        remoteOnly: true,
      }),
    );
    const store = new DesktopPreferenceStore(path);
    assert.equal(store.read().theme, "dark");
    assert.equal(store.read().revision, 7);
    assert.equal("remoteOnly" in store.read(), false);
    await store.save({ revision: 7, theme: "light" });
    await store.close();
    const restarted = new DesktopPreferenceStore(path);
    assert.equal(restarted.read().theme, "light");
    assert.equal(
      "remoteOnly" in JSON.parse(await readFile(path, "utf8")),
      false,
    );
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("preference commit failure leaves the previous state available for retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-theme-failure-"));
  const blocker = join(directory, "blocker");
  try {
    const store = new DesktopPreferenceStore(join(blocker, "preferences.json"));
    await writeFile(blocker, "blocks directory creation");
    await assert.rejects(store.save({ revision: 0, theme: "dark" }));
    assert.equal(store.read().theme, "system");
    assert.equal(store.read().revision, 0);
    await rm(blocker);
    await store.save({ revision: 0, theme: "dark" });
    assert.equal(store.read().theme, "dark");
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("update channel and auto update persist without rewriting unchanged preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-update-preferences-"));
  const path = join(directory, "preferences.json");
  try {
    const store = new DesktopPreferenceStore(path);
    assert.equal(store.read().updateChannel, undefined);
    assert.equal(store.read().autoUpdate, undefined);
    const saved = await store.save({
      revision: 0,
      updateChannel: "nightly",
      autoUpdate: true,
    });
    assert.equal(saved.updateChannel, "nightly");
    assert.equal(saved.autoUpdate, true);
    const raw = await readFile(path, "utf8");
    assert.equal(
      (await store.save({ revision: 1, autoUpdate: true })).revision,
      1,
    );
    assert.equal(await readFile(path, "utf8"), raw);
    await store.save({ revision: 1, theme: "dark" });
    await store.close();
    const restarted = new DesktopPreferenceStore(path);
    assert.equal(restarted.read().theme, "dark");
    assert.equal(restarted.read().updateChannel, "nightly");
    assert.equal(restarted.read().autoUpdate, true);
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
