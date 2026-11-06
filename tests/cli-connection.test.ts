import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { daemonCli } from "./helpers/daemon-cli.js";

// The installed CLI owns endpoint validation and command submission. The HTTP
// fixture only controls a delayed, stalled, or invalid external health response.
async function connection(mode: "slow" | "stalled" | "wrong-pid" | "denied") {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cli-health-"));
  const token = randomBytes(32).toString("hex");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let healthRequests = 0;
  let commands = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      healthRequests++;
      if (mode === "denied") {
        response.writeHead(401);
        response.end(
          JSON.stringify({ error: { code: "unauthorized", message: "拒绝" } }),
        );
        return;
      }
      const reply = () =>
        response.end(
          JSON.stringify({ pid: process.pid + (mode === "wrong-pid" ? 1 : 0) }),
        );
      // Fault injection, not readiness polling: a healthy response arrives after
      // the previous one-second preflight deadline, while still within a CLI call.
      if (mode === "slow") timer = setTimeout(reply, 1400);
      else if (mode !== "stalled") reply();
      return;
    }
    assert.equal(request.url, "/command");
    commands++;
    request.resume();
    request.once("end", () => response.end(JSON.stringify({ accepted: true })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(directory, "endpoint.json"),
    JSON.stringify({ port: address.port, token, pid: process.pid }),
  );
  return {
    directory,
    counts: () => ({ healthRequests, commands }),
    close: async () => {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true });
    },
  };
}

const command = () => ({
  id: randomUUID(),
  command: { type: "bot.create", name: "Connection fixture", description: "" },
});

await test("CLI waits for delayed authenticated health before submitting a command once", async (t) => {
  const fixture = await connection("slow");
  try {
    assert.deepEqual(await daemonCli(fixture.directory, "command", command()), {
      accepted: true,
    });
    assert.deepEqual(fixture.counts(), { healthRequests: 1, commands: 1 });
  } finally {
    t.diagnostic(JSON.stringify(fixture.counts()));
    await fixture.close();
  }
});

await test("CLI identifies a health timeout and submits no business command", async () => {
  const fixture = await connection("stalled");
  try {
    await assert.rejects(
      daemonCli(fixture.directory, "command", command()),
      /command bot\.create.*后台健康检查超时.*尚未提交业务请求/s,
    );
    assert.deepEqual(fixture.counts(), { healthRequests: 1, commands: 0 });
  } finally {
    await fixture.close();
  }
});

for (const mode of ["wrong-pid", "denied"] as const) {
  await test(`CLI rejects ${mode} without submitting or retrying a command`, async () => {
    const fixture = await connection(mode);
    try {
      await assert.rejects(
        daemonCli(fixture.directory, "command", command()),
        mode === "wrong-pid" ? /实际进程不匹配/ : /拒绝/,
      );
      assert.deepEqual(fixture.counts(), { healthRequests: 1, commands: 0 });
    } finally {
      await fixture.close();
    }
  });
}
