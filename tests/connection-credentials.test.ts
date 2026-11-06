import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConnections } from "../src/agent/connections.js";
import { PiCredentials } from "../src/agent/pi-credentials.js";
import { agentConnectionsRequestSchema } from "../src/shared/agent-connections.js";
import { piModelServer } from "./helpers/pi-model-server.js";

await test("API key requests reject empty, oversized, control-character and mismatched credentials", () => {
  const connection = {
    id: "custom",
    provider: "custom",
    model: "model",
    auth: "stored",
  };
  const request = { action: "check", connection };
  for (const apiKey of [
    "",
    "   ",
    "x".repeat(16001),
    "key\nheader",
    "key\u0000",
  ])
    assert.equal(
      agentConnectionsRequestSchema.safeParse({ ...request, apiKey }).success,
      false,
    );
  assert.equal(
    agentConnectionsRequestSchema.safeParse({
      ...request,
      connection: { ...connection, auth: "environment", apiKeyEnv: "KEY" },
      apiKey: "key",
    }).success,
    false,
  );
  assert.equal(
    agentConnectionsRequestSchema.safeParse({
      action: "save",
      revision: "",
      config: { defaultAgent: "custom", connections: [connection] },
      credential: { provider: "other", key: "key" },
    }).success,
    false,
  );
});

await test("draft keys are temporary, saved keys are sealed, and stale saves cannot replace credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-connection-key-"));
  const model = await piModelServer((_request, send) => {
    send({ role: "assistant", content: '{"ok":true}' });
    send({}, "stop");
  });
  try {
    const service = new AgentConnections(home);
    const connection = { ...model.connection, auth: "stored" as const };
    const signal = AbortSignal.timeout(30000);
    const empty = await service.request({ action: "status" }, signal);
    const checked = await service.request(
      { action: "check", connection, apiKey: "draft-secret" },
      signal,
    );
    assert.match(checked.notice, /未向模型/);
    assert.equal(model.requests.length, 0);
    await service.request(
      { action: "test", connection, apiKey: "draft-secret" },
      signal,
    );
    assert.equal(model.headers[0]?.authorization, "Bearer draft-secret");
    await assert.rejects(readFile(join(home, "pi-auth.sealed")), {
      code: "ENOENT",
    });
    const config = { defaultAgent: connection.id, connections: [connection] };
    const saved = await service.request(
      {
        action: "save",
        revision: empty.revision,
        config,
        credential: { provider: connection.provider, key: "saved-secret" },
      },
      signal,
    );
    assert.deepEqual(saved.storedProviders, [connection.provider]);
    assert.equal(JSON.stringify(saved).includes("saved-secret"), false);
    assert.equal(
      (await readFile(join(home, "pi-models.json"), "utf8")).includes("secret"),
      false,
    );
    assert.equal(
      (await readFile(join(home, "pi-auth.sealed"))).includes(
        Buffer.from("saved-secret"),
      ),
      false,
    );
    await assert.rejects(
      service.request(
        {
          action: "save",
          revision: empty.revision,
          config,
          credential: { provider: connection.provider, key: "stale-secret" },
        },
        signal,
      ),
      /配置已修改/,
    );
    // Reopening the service models a backend restart; an omitted key must retain the stored one.
    const restarted = new AgentConnections(home);
    const again = await restarted.request(
      { action: "save", revision: saved.revision, config },
      signal,
    );
    await restarted.request({ action: "test", connection }, signal);
    assert.equal(model.headers.at(-1)?.authorization, "Bearer saved-secret");
    assert.deepEqual(await new PiCredentials(home).read(connection.provider), {
      type: "api_key",
      key: "saved-secret",
    });
    await restarted.request(
      {
        action: "save",
        revision: again.revision,
        config,
        credential: {
          provider: connection.provider,
          key: "replacement-secret",
        },
      },
      signal,
    );
    await restarted.request({ action: "test", connection }, signal);
    assert.equal(
      model.headers.at(-1)?.authorization,
      "Bearer replacement-secret",
    );
  } finally {
    await model.close();
    await rm(home, { recursive: true, force: true });
  }
});
