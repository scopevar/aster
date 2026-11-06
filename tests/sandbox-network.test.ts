import assert from "node:assert/strict";
import { test } from "node:test";
import { Resolver } from "node:dns/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { SandboxDns } from "../src/sandbox/dns.js";
import { openDnsProxy } from "../src/sandbox/dns-proxy.js";
import { resolvePublicDns } from "../src/network/web-policy.js";
import { sandboxNetworkConfigurationSchema } from "../src/shared/tools/sandbox-settings.js";

// The real UDP boundary must not expose unapproved names or reserved addresses.
// Only external encrypted DNS is controlled; Node's DNS client parses the answers.
await test("sandbox DNS returns public A/AAAA, caches them and refuses unapproved names and Fake-IP", async () => {
  let lookups = 0;
  const dns = new SandboxDns(
    ["allowed.example.com", "fake.example.com"],
    async (hostname) => {
      lookups++;
      return {
        addresses:
          hostname === "fake.example.com"
            ? [{ address: "198.18.0.124", family: 4 }]
            : [
                { address: "93.184.216.34", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 },
              ],
        ttlSeconds: 60,
      };
    },
  );
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  try {
    resolver.setServers([await dns.open()]);
    assert.deepEqual(await resolver.resolve4("allowed.example.com"), [
      "93.184.216.34",
    ]);
    assert.deepEqual(await resolver.resolve6("allowed.example.com"), [
      "2606:4700:4700::1111",
    ]);
    assert.equal(lookups, 1);
    await assert.rejects(resolver.resolve4("other.example.com"), {
      code: "ENOTFOUND",
    });
    assert.equal(lookups, 1);
    await assert.rejects(resolver.resolve4("fake.example.com"), {
      code: "ESERVFAIL",
    });
    assert.match(dns.error, /非公网/);
  } finally {
    resolver.cancel();
    await dns.close();
  }
});

await test("closing DNS aborts an in-flight upstream query and releases the socket", async () => {
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const dns = new SandboxDns(
    ["allowed.example.com"],
    async (_hostname, signal) => {
      entered();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  );
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([await dns.open()]);
  const query = resolver.resolve4("allowed.example.com").catch(() => {});
  try {
    await waiting;
    await dns.close();
    assert.equal(aborted, true);
    await dns.close();
  } finally {
    resolver.cancel();
    await query;
    await dns.close();
  }
});

await test("configured DNS proxy receives the fixed CONNECT target; failures and cancellation never fall back to direct DNS", async () => {
  const server = createServer();
  const targets: string[] = [];
  const sockets = new Set<Duplex>();
  server.on("connect", (request, socket) => {
    targets.push(request.url ?? "");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await openDnsProxy({
    protocol: "http",
    address: `127.0.0.1:${address.port}`,
  });
  try {
    await assert.rejects(
      resolvePublicDns("example.com", AbortSignal.timeout(3000), proxy.request),
    );
    assert.ok(targets.length > 0);
    assert.ok(targets.every((target) => target === "cloudflare-dns.com:443"));
    await assert.rejects(
      proxy.request("https://other.example.com/dns-query"),
      /固定/,
    );
    await assert.rejects(
      proxy.request("https://cloudflare-dns.com/dns-query", {
        signal: AbortSignal.abort(),
      }),
    );
  } finally {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

await test("sandbox configuration accepts literal IP endpoints and rejects credentials, paths and invalid ports", () => {
  for (const address of ["127.0.0.1:7897", "[::1]:1080"])
    assert.equal(
      sandboxNetworkConfigurationSchema.safeParse({
        dns: { mode: "auto" },
        proxy: { protocol: "socks5", address },
      }).success,
      true,
    );
  for (const address of [
    "proxy.example.com:7897",
    "http://127.0.0.1:7897",
    "user:pass@127.0.0.1:7897",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:7897/path",
    "127.0.0.1:7897#x",
  ])
    assert.equal(
      sandboxNetworkConfigurationSchema.safeParse({
        dns: { mode: "custom", servers: [address] },
        proxy: null,
      }).success,
      false,
      address,
    );
});
