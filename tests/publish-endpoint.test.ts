import { test } from "node:test";
import assert from "node:assert/strict";
import { lockFile } from "./helpers/windows-file-lock.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishEndpoint } from "../src/platform/publish-endpoint.js";

await test(
  "endpoint publication tolerates a real Windows delete lock and preserves the previous record on permanent failure",
  { timeout: 15000, skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-endpoint-"));
    let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
    try {
      const endpoint = join(directory, "endpoint.json");
      await writeFile(endpoint, JSON.stringify({ generation: 1 }));
      lock = await lockFile(endpoint, 350);
      await publishEndpoint(directory, { generation: 2 });
      await lock.close();
      assert.deepEqual(JSON.parse(await readFile(endpoint, "utf8")), {
        generation: 2,
      });
      lock = await lockFile(endpoint, 0);
      await assert.rejects(publishEndpoint(directory, { generation: 3 }));
      assert.deepEqual(JSON.parse(await readFile(endpoint, "utf8")), {
        generation: 2,
      });
      assert.deepEqual(await readdir(directory), ["endpoint.json"]);
    } finally {
      await lock?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
