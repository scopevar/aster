import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { downloadScriptAsset } from "../src/sandbox/asset-download.js";
import { SandboxResources } from "../src/sandbox/resources.js";
import { SandboxProcess } from "../src/sandbox/process.js";
import { SandboxService } from "../src/sandbox/service.js";
import { Store } from "../src/storage/store.js";

// Owner: actual HTTP and filesystem downloads, plus the daemon-owned preparation service.
// Only the external preparation process is controlled in service tests. Existing script tests
// cover approval; the real VM suite covers image pulls, startup and execution together.
async function downloadFixture(t: TestContext, handler: RequestListener) {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "sandbox-resources-"));
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/asset`,
    path: join(directory, "asset.bin"),
  };
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

await test("interrupted resource downloads persist bytes and resume with Range after restart", async (t) => {
  const bytes = Buffer.alloc(128 * 1024, 37);
  const cut = 32768;
  const ranges: Array<string | undefined> = [];
  const controller = new AbortController();
  const fixture = await downloadFixture(t, (request, response) => {
    ranges.push(request.headers.range);
    if (ranges.length === 1) {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.write(bytes.subarray(0, cut));
      return;
    }
    assert.equal(request.headers.range, `bytes=${cut}-`);
    response.writeHead(206, {
      "Content-Range": `bytes ${cut}-${bytes.length - 1}/${bytes.length}`,
      "Content-Length": bytes.length - cut,
    });
    response.end(bytes.subarray(cut));
  });
  const asset = { ...fixture, sha256: digest(bytes), limit: bytes.length };
  await assert.rejects(
    downloadScriptAsset(asset, controller.signal, (received) => {
      if (received >= cut) controller.abort();
    }),
    (error: Error) => error.name === "AbortError",
  );
  assert.deepEqual(
    await readFile(`${fixture.path}.part`),
    bytes.subarray(0, cut),
  );
  await assert.rejects(access(fixture.path));
  assert.deepEqual(
    await downloadScriptAsset(asset, new AbortController().signal),
    bytes,
  );
  await assert.rejects(access(`${fixture.path}.part`));
  assert.deepEqual(
    await downloadScriptAsset(asset, new AbortController().signal),
    bytes,
  );
  assert.equal(
    ranges.length,
    2,
    "a verified cache must not issue another request",
  );
});

await test("a server ignoring Range replaces partial bytes and still verifies the result", async (t) => {
  const bytes = Buffer.from("complete immutable resource");
  const fixture = await downloadFixture(t, (request, response) => {
    assert.equal(request.headers.range, "bytes=5-");
    response.writeHead(200, { "Content-Length": bytes.length });
    response.end(bytes);
  });
  await writeFile(`${fixture.path}.part`, bytes.subarray(0, 5));
  const result = await downloadScriptAsset(
    { ...fixture, sha256: digest(bytes), limit: bytes.length },
    new AbortController().signal,
  );
  assert.deepEqual(result, bytes);
  assert.deepEqual(await readFile(fixture.path), bytes);
});

await test("invalid ranges, oversized bodies and bad hashes never publish usable resources", async (t) => {
  for (const fault of ["range", "size", "hash"] as const) {
    await t.test(fault, async (t) => {
      const bytes = Buffer.from("expected resource");
      const fixture = await downloadFixture(t, (_request, response) => {
        if (fault === "range") {
          response.writeHead(206, {
            "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
          });
          response.end(bytes);
        } else {
          response.writeHead(200, {
            "Content-Length":
              fault === "size" ? bytes.length * 2 : bytes.length,
          });
          response.end(bytes);
        }
      });
      if (fault === "range") await writeFile(`${fixture.path}.part`, "old");
      await assert.rejects(
        downloadScriptAsset(
          {
            ...fixture,
            sha256: digest(Buffer.from("different content")),
            limit: bytes.length,
          },
          new AbortController().signal,
        ),
        fault === "range"
          ? /无效的续传范围/
          : fault === "size"
            ? /下载上限/
            : /校验失败/,
      );
      await assert.rejects(access(fixture.path));
      if (fault === "hash")
        await assert.rejects(access(`${fixture.path}.part`));
    });
  }
});

await test("background preparation is shared and survives cancellation of one chat waiter", async (t) => {
  let finish: () => void = () => {
    throw new Error("preparation not started");
  };
  let preparations = 0;
  t.mock.method(SandboxProcess.prototype, "prepare", () => {
    preparations++;
    // The real process is the external dependency; the shared owner and chat waits remain real.
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  t.mock.method(SandboxProcess.prototype, "close", async () => {});
  const resources = new SandboxResources("unused-preparation-fixture");
  t.after(() => resources.stop());
  resources.start();
  assert.equal(resources.view().state, "preparing");
  const cancelled = new AbortController();
  const pending = resources.wait(cancelled.signal, () => {});
  const rejection = assert.rejects(
    pending,
    (error: Error) => error.name === "AbortError",
  );
  const other = resources.wait(new AbortController().signal, () => {});
  cancelled.abort();
  await rejection;
  assert.equal(preparations, 1);
  assert.equal(resources.view().state, "preparing");
  finish();
  await other;
  assert.equal(resources.view().state, "ready");
  await resources.wait(new AbortController().signal, () => {});
  assert.equal(preparations, 1);
});

await test("daemon preparation starts without a script approval and can retry a failed attempt", async (t) => {
  let attempts = 0;
  t.mock.method(SandboxProcess.prototype, "prepare", async () => {
    if (++attempts === 1) throw new Error("resource download interrupted");
  });
  t.mock.method(SandboxProcess.prototype, "close", async () => {});
  const store = new Store(":memory:");
  const sandbox = new SandboxService(store, "unused-preparation-fixture");
  const resources = new SandboxResources("unused-retry-fixture");
  try {
    resources.start();
    await assert.rejects(
      resources.wait(new AbortController().signal, () => {}),
      /resource download interrupted/,
    );
    assert.equal(resources.view().state, "unprepared");
    await resources.wait(new AbortController().signal, () => {});
    assert.equal(resources.view().state, "ready");
    assert.equal(attempts, 2);
    sandbox.start();
    assert.equal(
      attempts,
      3,
      "starting the service must begin preparation without a Bot run",
    );
  } finally {
    await sandbox.stop();
    await resources.stop();
    store.close();
  }
});
