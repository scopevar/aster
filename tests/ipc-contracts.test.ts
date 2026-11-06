import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../src/shared/core.js";
import {
  createDesktopBridge,
  createDesktopSubscriptions,
  desktopEventChannel,
  type DesktopBridge,
  type DesktopChannel,
} from "../src/shared/ipc-contracts.js";
import type { WorkerSignal } from "../src/shared/worker-events.js";
import {
  createDesktopClient,
  subscribeWorker,
  unwrap,
} from "../src/ui/lib/client.js";
import {
  parseInput,
  settle,
  unconfirmedFailure,
} from "../src/desktop/ipc/ipc-result.js";

function recordingBridge() {
  const calls: { channel: DesktopChannel; args: unknown[] }[] = [];
  const bridge = createDesktopBridge(
    <T>(channel: DesktopChannel, ...args: unknown[]): Promise<T> => {
      calls.push({ channel, args });
      return new Promise<T>(() => {});
    },
  );
  return { bridge, calls };
}

await test("every bridge method invokes its own aster:<method> channel with the given arguments", () => {
  const { bridge, calls } = recordingBridge();
  const methods = Object.keys(bridge);
  assert.ok(methods.length > 30);
  for (const method of methods) {
    const fn: unknown = Reflect.get(bridge, method);
    assert.equal(typeof fn, "function");
    if (typeof fn === "function") void Reflect.apply(fn, bridge, [method, 1]);
  }
  assert.deepEqual(
    calls.map((call) => call.channel),
    methods.map((method) => `aster:${method}`),
  );
  for (const [index, call] of calls.entries())
    assert.deepEqual(call.args, [methods[index], 1]);
  assert.equal(new Set(calls.map((call) => call.channel)).size, calls.length);
});

await test("renderer client exposes exactly the bridge methods and restores AppError codes", async () => {
  const { bridge } = recordingBridge();
  const replies: DesktopBridge = {
    ...bridge,
    preferences: () =>
      Promise.resolve({
        success: false,
        error: { code: "conflict", message: "设置已发生变化" },
      }),
    chooseDirectory: () => Promise.resolve({ success: true, data: "/tmp/a" }),
  };
  const client = createDesktopClient(() => replies);
  assert.deepEqual(Object.keys(client).sort(), Object.keys(bridge).sort());
  assert.equal(
    await client.chooseDirectory("00000000-0000-4000-8000-000000000001"),
    "/tmp/a",
  );
  await assert.rejects(
    client.preferences(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "conflict" &&
      error.message === "设置已发生变化",
  );
  assert.equal(unwrap({ success: true, data: 3 }), 3);
});

await test("settle converts handler outcomes into cloneable results without leaking internals", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  assert.deepEqual(await settle(() => 1), { success: true, data: 1 });
  assert.deepEqual(await settle(() => undefined), {
    success: true,
    data: undefined,
  });
  assert.deepEqual(
    await settle(() => {
      throw new AppError("capacity", "繁忙");
    }),
    { success: false, error: { code: "capacity", message: "繁忙" } },
  );
  assert.deepEqual(
    await settle(() => Promise.reject(new Error("ENOENT /home/secret/path"))),
    { success: false, error: unconfirmedFailure },
  );
  assert.deepEqual(
    await settle(() => z.object({ a: z.string() }).parse({}), {
      code: "unknown",
      message: "兜底",
    }),
    { success: false, error: { code: "unknown", message: "兜底" } },
  );
  const aborted = await settle(() => {
    const controller = new AbortController();
    controller.abort();
    controller.signal.throwIfAborted();
  });
  assert.equal(aborted.success ? "" : aborted.error.code, "unavailable");
  assert.equal(logged.mock.callCount(), 2);
});

await test("worker signal subscriptions use the declared channel, drop invalid payloads and unsubscribe symmetrically", () => {
  const registered = new Map<string, Set<(payload: unknown) => void>>();
  const events = createDesktopSubscriptions((channel, listener) => {
    const set = registered.get(channel) ?? new Set();
    set.add(listener);
    registered.set(channel, set);
    return () => set.delete(listener);
  });
  const received: WorkerSignal[] = [];
  const unsubscribe = subscribeWorker(
    (signal) => received.push(signal),
    () => events,
  );
  const channel = desktopEventChannel("workerSignal");
  assert.deepEqual([...registered.keys()], [channel]);
  const emit = (payload: unknown) => {
    for (const listener of registered.get(channel) ?? []) listener(payload);
  };
  const cursor = { epoch: "00000000-0000-4000-8000-000000000001", revision: 2 };
  emit({ state: "live", cursor });
  emit({ state: "live", cursor: { ...cursor, text: "用户数据" } });
  emit({ state: "offline" });
  emit("garbage");
  assert.deepEqual(received, [{ state: "live", cursor }, { state: "offline" }]);
  unsubscribe();
  assert.equal(registered.get(channel)?.size, 0);
  emit({ state: "offline" });
  assert.equal(received.length, 2);
});

await test("parseInput reports renderer input mismatches as invalid_input", () => {
  assert.equal(
    parseInput(z.uuid(), "00000000-0000-4000-8000-000000000001"),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.throws(
    () => parseInput(z.uuid(), "x", "编号无效"),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "invalid_input" &&
      error.message === "编号无效",
  );
});
