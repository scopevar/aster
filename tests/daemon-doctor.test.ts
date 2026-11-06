import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  defaultSecretBox,
  safeStorageSecretBox,
} from "../src/security/secret.js";
import { ownDirectory } from "../src/platform/directory-lease.js";
import { readWorker } from "../src/worker/client.js";

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path));
    else
      result[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return result;
}

async function doctor(directory: string) {
  const child = spawn(process.execPath, ["scripts/dev.mjs", "--doctor"], {
    env: { ...process.env, ASTER_DATA_DIR: directory },
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, output };
}

// Owner: real dev --doctor, OS encryption and data-directory leases. The former
// script fixture replaced maintenance entirely and could not catch false green.
await test("doctor rejects unreadable credentials without changing user files", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows DPAPI acceptance");
  const root = await mkdtemp(join(tmpdir(), "aster-doctor-bad-"));
  try {
    await mkdir(join(root, "agent"));
    await writeFile(
      join(root, "agent", "pi-auth.sealed"),
      "corrupt-credential-canary",
    );
    const before = await snapshot(root);
    const result = await doctor(root);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /凭据.*无法|凭据.*失败/);
    assert.doesNotMatch(result.output, /检查通过|corrupt-credential-canary/);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("doctor validates DPAPI and existing safeStorage credentials read-only", async (t) => {
  if (process.platform !== "win32") return t.skip("Real Windows OS protection");
  const root = await mkdtemp(join(tmpdir(), "aster-doctor-good-"));
  const previous = process.env.ASTER_STRICT_SECRETS;
  process.env.ASTER_STRICT_SECRETS = "1";
  try {
    const agent = join(root, "agent");
    await mkdir(agent);
    for (const box of [defaultSecretBox(agent), safeStorageSecretBox(agent)]) {
      await writeFile(
        join(agent, "pi-auth.sealed"),
        await box.seal(Buffer.from(JSON.stringify({ secret: "a".repeat(64) }))),
      );
      const before = await snapshot(root);
      const result = await doctor(root);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /凭据.*检查通过|凭据.*可解密/);
      assert.doesNotMatch(result.output, new RegExp("a".repeat(64)));
      assert.deepEqual(await snapshot(root), before);
    }
    await writeFile(join(agent, "pi-auth.sealed"), "corrupt-model-canary");
    const before = await snapshot(root);
    const invalidModel = await doctor(root);
    assert.equal(invalidModel.code, 2, invalidModel.output);
    assert.match(invalidModel.output, /pi-auth.sealed.*无法解密/);
    assert.doesNotMatch(invalidModel.output, /检查通过|corrupt-model-canary/);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    if (previous === undefined) delete process.env.ASTER_STRICT_SECRETS;
    else process.env.ASTER_STRICT_SECRETS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

await test("doctor refuses an unhealthy directory owner and does not create a new data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-doctor-owner-"));
  const lease = await ownDirectory(root, "worker");
  try {
    const blocked = await doctor(root);
    assert.equal(blocked.code, 2, blocked.output);
    assert.doesNotMatch(blocked.output, /检查通过/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await lease.close();
    await rm(root, { recursive: true, force: true });
  }
  const missing = resolve(tmpdir(), `aster-doctor-missing-${randomUUID()}`);
  const fresh = await doctor(missing);
  assert.equal(fresh.code, 0, fresh.output);
  await assert.rejects(readdir(missing), { code: "ENOENT" });
});

await test("doctor connects to a healthy daemon without stopping or replacing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-doctor-live-"));
  const { startWorker } = await import("../src/worker/server.js");
  const instanceId = randomUUID();
  const worker = await startWorker(root, { daemon: { instanceId } });
  try {
    const result = await doctor(root);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /连接现有实例/);
    assert.match(result.output, /未重读磁盘凭据/);
    assert.doesNotMatch(result.output, /先停止并更新/);
    assert.equal((await readWorker(root)).instanceId, instanceId);
  } finally {
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});
