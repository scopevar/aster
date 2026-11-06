import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { SessionRequests } from "../src/worker/session-requests.js";

await test("request drain waits for cancellation cleanup before releasing a session", async () => {
  const requests = new SessionRequests();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let aborted = false;
  const server = createServer((incoming, response) => {
    void requests.run(incoming, response, async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      started();
      await cleanup;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = fetch(`http://127.0.0.1:${address.port}/`, {
    signal: AbortSignal.timeout(5000),
  });
  try {
    await ready;
    let drained = false;
    const draining = requests.close().then(() => {
      drained = true;
    });
    const cancelled = await client;
    assert.equal(cancelled.status, 503);
    await cancelled.text();
    assert.equal(aborted, true);
    assert.equal(drained, false);
    complete();
    await draining;
    assert.equal(drained, true);
  } finally {
    complete();
    await requests.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
