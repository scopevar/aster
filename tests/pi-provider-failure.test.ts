import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgent } from "../src/agent/pi.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { AppError } from "../src/shared/core.js";

// Owner: the real Pi SDK wire request, shared by inference tests and chat turns.
// The old fixture only used thinking=off, hiding gateways that reject developer.
await test("compatible chat completions keep thinking enabled and send system instructions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-role-"));
  const model = await piModelServer((request, send, response) => {
    if (request.messages.some((message) => message.role === "developer")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "messages[0].role: unknown variant 'developer'",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    send({ role: "assistant", content: '{"ok":true}' });
    send({}, "stop");
  });
  try {
    const workspace = join(root, "bot");
    await mkdir(workspace);
    for (const mode of ["test", "run"] as const) {
      await t.test(mode, async () => {
        const agent = new PiAgent(root, {
          ...model.connection,
          thinking: "medium",
        });
        if (mode === "test")
          assert.match(
            (await agent.test(AbortSignal.timeout(10000))).detail,
            /真实推理测试通过/,
          );
        else {
          const result = await agent.run({
            workspace,
            sessionScope: { conversationId: randomUUID(), botId: "bot" },
            threadId: null,
            text: "hello",
            instructions: "Return a JSON object.",
            signal: AbortSignal.timeout(10000),
            onEvent() {},
          });
          assert.equal(result.status, "completed");
        }
        const request = model.requests.at(-1);
        assert.equal(request?.messages[0]?.role, "system");
        assert.equal(request?.reasoning_effort, "medium");
      });
    }
    assert.equal(model.requests.length, 2, "No automatic retries");
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Owner: PiAgent.test uses real structured inference. This distinguishes a
// rejected request from invalid JSON, without exposing arbitrary upstream data.
for (const scenario of ["request", "empty", "json", "valid"] as const) {
  await test(`structured inference distinguishes ${scenario} results without leaking responses`, async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-pi-structured-"));
    const secret = "secret-fixture-payload";
    const model = await piModelServer((_request, send, response) => {
      if (scenario === "request") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: `Invalid request; ${secret}` } }),
        );
        return;
      }
      if (scenario !== "empty")
        send({
          role: "assistant",
          content: scenario === "valid" ? '{"ok":true}' : secret,
        });
      send({}, "stop");
    });
    try {
      const result = new PiAgent(root, model.connection).test(
        AbortSignal.timeout(10000),
      );
      if (scenario === "valid")
        assert.match((await result).detail, /真实推理测试通过/);
      else {
        const expected = {
          request:
            "Pi 模型请求失败；请检查提供商、认证和模型配置，未自动重试。",
          empty: "模型未返回内容；未自动重试。",
          json: "Pi 结构化推理未返回有效 JSON；未自动重试。",
        };
        await assert.rejects(result, (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "unavailable");
          assert.equal(error.message, expected[scenario]);
          assert.equal(error.message.includes(secret), false);
          return true;
        });
      }
      assert.equal(model.requests.length, 1, "No automatic retries");
    } finally {
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test("an unavailable upstream is reported clearly without exposing the response or retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-upstream-"));
  const model = await piModelServer((_request, _send, response) => {
    response.end(
      'data: {"error":{"message":"Upstream service temporarily unavailable; secret-fixture-payload","type":"server_error"}}\n\n',
    );
  });
  try {
    const workspace = join(root, "bot");
    await mkdir(workspace);
    const result = await new PiAgent(root, model.connection).run({
      workspace,
      sessionScope: { conversationId: randomUUID(), botId: "bot" },
      threadId: null,
      text: "hello",
      instructions: "",
      signal: AbortSignal.timeout(10000),
      onEvent() {},
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /供应商的上游服务暂不可用/);
    assert.equal(
      JSON.stringify(result).includes("secret-fixture-payload"),
      false,
    );
    assert.equal(model.requests.length, 1);
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
