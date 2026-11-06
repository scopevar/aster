import { test } from "node:test";
import assert from "node:assert/strict";
import { WebPolicy, publicWebAddress } from "../src/network/web-policy.js";

void test("web policy rejects non-public addresses, credentials, ports and DNS rebinding before transport", async () => {
  for (const address of [
    "127.1",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.0.1",
    "169.254.169.254",
    "198.18.1.2",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
    "1000::1",
  ])
    assert.equal(publicWebAddress(address), false, address);
  assert.equal(publicWebAddress("1.1.1.1"), true);
  assert.equal(publicWebAddress("2606:4700:4700::1111"), true);
  let count = 0;
  const policy = new WebPolicy(async () => ({
    addresses: [
      { address: ++count === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 },
    ],
    ttlSeconds: 0,
  }));
  const signal = new AbortController().signal;
  for (const url of [
    "http://localhost/",
    "http://x.local/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://[::ffff:127.0.0.1]/",
    "http://user:pass@example.com/",
    "http://example.com:22/",
    "file:///etc/passwd",
    "http://example.com/#fragment",
  ])
    await assert.rejects(policy.target("GET", url, signal), url);
  for (const authority of [
    "example.com:80",
    "example.com:443/path",
    "user@example.com:443",
    "example.com:443?x=1",
    "127.0.0.1:443",
  ])
    await assert.rejects(policy.target("CONNECT", authority, signal));
  assert.equal(count, 0);
  const target = await policy.target("GET", "http://public.example/", signal);
  assert.equal(target.address, "1.1.1.1");
  await assert.rejects(policy.target("GET", "http://public.example/", signal));
  const mixed = new WebPolicy(async () => ({
    addresses: [
      { address: "1.1.1.1", family: 4 },
      { address: "::1", family: 6 },
    ],
    ttlSeconds: 100,
  }));
  await assert.rejects(mixed.target("GET", "http://mixed.example/", signal));
});

void test("DNS concurrency is bounded and actual cancellation drains accepted resolutions", async () => {
  let cancelled = 0;
  const policy = new WebPolicy(
    (_name, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled++;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const tasks = Array.from({ length: 32 }, (_, index) =>
    policy.target("GET", `http://item${index}.example/`, controller.signal),
  );
  const done = Promise.allSettled(tasks);
  await assert.rejects(
    policy.target("GET", "http://overflow.example/", controller.signal),
    /busy/,
  );
  controller.abort();
  assert.equal(
    (await done).filter((result) => result.status === "rejected").length,
    32,
  );
  assert.equal(cancelled, 32);
});
