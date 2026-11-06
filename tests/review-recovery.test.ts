import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotUpdateSchema } from "../src/shared/snapshot.js";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";

await test("agent check invalidates incremental snapshots without an application write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-capability-revision-"));
  let available = true;
  const worker = await startWorker(dir, {
    port: 0,
    agent: {
      check: async () => {
        if (!available) throw new Error("fixture unavailable");
        return { accountType: "fixture", detail: "ready" };
      },
      run: async () => ({ status: "completed", error: null }),
    },
  });
  try {
    let view = snapshotUpdateSchema.parse(
      await callWorker(worker.endpoint, "/snapshot", {}),
    );
    assert.ok(view.changed);
    for (const expected of ["ready", "unavailable"]) {
      const since = {
        epoch: view.snapshot.epoch,
        revision: view.snapshot.revision,
      };
      await callWorker(worker.endpoint, "/command", {
        id: randomUUID(),
        command: { type: "agent.check" },
      });
      view = snapshotUpdateSchema.parse(
        await callWorker(worker.endpoint, "/snapshot", { since }),
      );
      assert.ok(view.changed);
      assert.equal(view.snapshot.capabilities.agent, expected);
      assert.ok(view.snapshot.revision > since.revision);
      available = false;
    }
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
