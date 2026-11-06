import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import { AgentConnections } from "../src/agent/connections.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

await test("saving Pi configuration fences an older check even if it completes after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-check-"));
  let release: () => void = () => {},
    started: () => void = () => {};
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  const began = new Promise<void>((accept) => {
    started = accept;
  });
  const worker = await startWorker(root, {
    port: 0,
    agent: {
      async check() {
        started();
        await gate;
        return { accountType: "old-provider", detail: "old check" };
      },
      async run() {
        throw Error("No model turn is expected");
      },
    },
  });
  try {
    const checking = callWorker(worker.endpoint, "/command", {
      id: randomUUID(),
      command: { type: "agent.check" },
    });
    await began;
    const status = new AgentConnections(join(root, "agent")).status();
    await callWorker(worker.endpoint, "/agent-connections", {
      action: "save",
      revision: status.revision,
      config: status.config,
    });
    release();
    await checking;
    const snapshot = await workerSnapshot(worker.endpoint);
    assert.equal(snapshot.capabilities.agent, "unchecked");
    assert.equal(snapshot.capabilities.accountType, null);
    assert.match(snapshot.capabilities.detail, /供应商配置已更新/);
  } finally {
    release();
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});
