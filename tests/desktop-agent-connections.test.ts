import assert from "node:assert/strict";
import { test } from "node:test";
import { requestAgentConnections } from "../src/desktop/ipc/agent-connections.js";
import { settle } from "../src/desktop/ipc/ipc-result.js";
import {
  agentConnectionsRequestSchema,
  agentConnectionSchema,
  type AgentConnectionsRequest,
  type AgentConnectionsStatus,
} from "../src/shared/agent-connections.js";
import { AppError } from "../src/shared/core.js";
import type { Result } from "../src/shared/ipc-contracts.js";

const status: AgentConnectionsStatus = {
  revision: "a".repeat(64),
  path: "config.json",
  config: {
    defaultAgent: "openai",
    connections: [
      agentConnectionSchema.parse({
        id: "openai",
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      }),
    ],
  },
  active: "Pi",
  override: null,
  notice: "",
};
const save: AgentConnectionsRequest = {
  action: "save",
  revision: status.revision,
  config: status.config,
};

await test("an old resident worker produces an actionable IPC failure and never receives a save or check", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  for (const restartRequired of [false, true]) {
    const requests: AgentConnectionsRequest[] = [];
    const worker = {
      async call(path: string, body?: unknown): Promise<unknown> {
        assert.equal(path, "/agent-connections");
        requests.push(agentConnectionsRequestSchema.parse(body));
        return { ...status, restartRequired };
      },
    };
    const inputs: AgentConnectionsRequest[] = [
      { action: "status" },
      save,
      { action: "check", connection: status.config.connections[0]! },
    ];
    for (const input of inputs) {
      const reply: Result<AgentConnectionsStatus> = await settle(
        (): Promise<AgentConnectionsStatus> =>
          requestAgentConnections(worker, input),
      );
      assert.equal(reply.success, false);
      if (reply.success) assert.fail("old worker cannot claim hot reload");
      assert.equal(reply.error.code, "conflict");
      assert.match(reply.error.message, /旧版/);
      assert.match(reply.error.message, /通用/);
    }
    assert.deepEqual(
      requests.map((request) => request.action),
      ["status", "status", "status"],
    );
  }
  assert.equal(logged.mock.callCount(), 0);
});

await test("the current worker's status and save retain strict validation and surface the actual applied result", async () => {
  const requests: AgentConnectionsRequest[] = [];
  const applied = { ...status, notice: "已保存并应用" };
  const worker = {
    async call(_path: string, body?: unknown): Promise<unknown> {
      const request = agentConnectionsRequestSchema.parse(body);
      requests.push(request);
      return request.action === "save" ? applied : status;
    },
  };
  assert.deepEqual(
    await requestAgentConnections(worker, { action: "status" }),
    status,
  );
  assert.deepEqual(await requestAgentConnections(worker, save), applied);
  assert.deepEqual(
    requests.map((request) => request.action),
    ["status", "status", "save"],
  );
});

await test("invalid status prevents writes and invalid mutation replies remain unconfirmed without leaking payloads", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const secret = "private-payload";
  const calls: unknown[] = [];
  const invalid = {
    async call(_path: string, body?: unknown): Promise<unknown> {
      calls.push(body);
      return { ...status, unexpected: secret };
    },
  };
  await assert.rejects(
    requestAgentConnections(invalid, save),
    (error: unknown) =>
      error instanceof AppError && error.code === "unavailable",
  );
  assert.equal(calls.length, 1);
  for (const value of [
    { ...status, unexpected: secret },
    { ...status, restartRequired: false },
  ]) {
    let requests = 0;
    const worker = {
      async call(): Promise<unknown> {
        return ++requests === 1 ? status : value;
      },
    };
    const reply: Result<AgentConnectionsStatus> = await settle(
      (): Promise<AgentConnectionsStatus> =>
        requestAgentConnections(worker, save),
    );
    assert.equal(reply.success, false);
    if (reply.success) assert.fail("invalid mutation reply is unconfirmed");
    assert.equal(reply.error.code, "unknown");
    assert.match(reply.error.message, /未确认/);
    assert.ok(!JSON.stringify(reply).includes(secret));
    assert.equal(requests, 2, "an unconfirmed save is never retried");
  }
  assert.equal(logged.mock.callCount(), 0);
});
