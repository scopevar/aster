import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgent } from "../src/agent/live.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { agentConnectionSchema } from "../src/shared/agent-connections.js";

await test("a captured Pi run keeps its configuration while the next capture observes new settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-live-pi-"));
  try {
    const config = {
      defaultAgent: "openai",
      connections: [
        agentConnectionSchema.parse({
          id: "openai",
          provider: "openai",
          model: "gpt-5.4",
          apiKeyEnv: "ASTER_TEST_MISSING_PI_FIRST",
        }),
      ],
    };
    await writeFile(modelConfigPath(home), JSON.stringify(config));
    const live = new LiveAgent(home),
      captured = live.capture();
    config.connections[0]!.apiKeyEnv = "ASTER_TEST_MISSING_PI_SECOND";
    await writeFile(modelConfigPath(home), JSON.stringify(config));
    await assert.rejects(captured.check(), /ASTER_TEST_MISSING_PI_FIRST/);
    await assert.rejects(live.check(), /ASTER_TEST_MISSING_PI_SECOND/);
    assert.equal(live.requiresFreshSession("legacy-provider-thread"), true);
    assert.equal(live.requiresFreshSession("aster-session:legacy"), true);
    assert.equal(
      live.requiresFreshSession("pi:v1:" + "a".repeat(64) + ":Zm9vLmpzb25s"),
      false,
    );
    assert.equal(live.requiresFreshSession(null), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
