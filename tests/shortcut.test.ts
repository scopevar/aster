import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  writeFile,
  rm,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopPreferenceStore } from "../src/desktop/native/preferences.js";
import { DesktopShortcut } from "../src/desktop/native/shortcut.js";
import { shortcutSchema } from "../src/shared/desktop/shortcut.js";

const first = { control: true, alt: true, shift: true, key: "F23" };
const second = { ...first, key: "F24" };
function nativeFixture() {
  const registered = new Map<string, () => void>();
  return {
    registered,
    register: (key: string, callback: () => void) => {
      if (registered.has(key)) return false;
      registered.set(key, callback);
      return true;
    },
    unregister: (key: string) => {
      registered.delete(key);
    },
    isRegistered: (key: string) => registered.has(key),
  };
}

await test("shortcut reservations are inert, rollback retains the previous key, and close fences late commit", () => {
  const native = nativeFixture();
  let activations = 0;
  const service = new DesktopShortcut(native, () => {
    activations++;
  });
  service.start(first);
  native.registered.get("Control+Alt+Shift+F23")?.();
  assert.equal(activations, 1);
  const reservation = service.prepare(second);
  native.registered.get("Control+Alt+Shift+F24")?.();
  assert.equal(activations, 1);
  reservation.rollback();
  assert.equal(native.registered.size, 1);
  const committing = service.prepare(second);
  committing.commit();
  assert.equal(native.registered.has("Control+Alt+Shift+F23"), false);
  const late = native.registered.get("Control+Alt+Shift+F24");
  const pending = service.prepare(first);
  service.close();
  pending.commit();
  late?.();
  assert.equal(activations, 1);
  assert.equal(native.registered.size, 0);
  assert.equal(service.status(first).state, "unavailable");
  assert.throws(() => service.prepare(first), /关闭/);
  for (const key of ["Delete", "Tab", "F25", "A+Alt", "Meta", "a"])
    assert.equal(shortcutSchema.safeParse({ ...first, key }).success, false);
});

await test("shortcut persistence failure releases the reservation and keeps the real file revision and previous key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-shortcut-failure-"));
  const parent = join(directory, "settings"),
    held = join(directory, "held");
  const native = nativeFixture(),
    service = new DesktopShortcut(native, () => {});
  service.start(null);
  const store = new DesktopPreferenceStore(
    join(parent, "preferences.json"),
    service,
  );
  try {
    await store.save({ revision: 0, shortcut: first });
    const original = await readFile(join(parent, "preferences.json"), "utf8");
    await rename(parent, held);
    await writeFile(parent, "blocks directory creation");
    await assert.rejects(store.save({ revision: 1, shortcut: second }));
    assert.equal(store.read().revision, 1);
    assert.deepEqual(store.read().shortcut, first);
    assert.deepEqual([...native.registered.keys()], ["Control+Alt+Shift+F23"]);
    assert.equal(
      await readFile(join(held, "preferences.json"), "utf8"),
      original,
    );
    await rm(parent);
    await rename(held, parent);
    const attempts = await Promise.allSettled([
      store.save({ revision: 1, shortcut: second }),
      store.save({ revision: 1, shortcut: null }),
    ]);
    assert.equal(attempts[0]?.status, "fulfilled");
    assert.equal(attempts[1]?.status, "rejected");
    assert.equal(store.read().shortcutStatus.state, "active");
    await store.save({ revision: 2, shortcut: null });
    assert.equal(native.registered.size, 0);
  } finally {
    service.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("version two preferences preserve theme and stay untouched until a successful version three save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-shortcut-migrate-"));
  const path = join(directory, "preferences.json");
  try {
    await mkdir(join(directory, "existing"));
    const source = JSON.stringify({
      version: 2,
      revision: 8,
      theme: "dark",
      timeZone: "UTC",
      hardwareAcceleration: false,
    });
    await writeFile(path, source);
    const store = new DesktopPreferenceStore(path);
    assert.equal(store.read().version, 3);
    assert.equal(store.read().theme, "dark");
    assert.equal(store.read().shortcut, null);
    assert.equal(await readFile(path, "utf8"), source);
    await store.save({ revision: 8, timeZone: "Asia/Shanghai" });
    await store.close();
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
