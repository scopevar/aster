import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgent } from "../src/agent/pi.js";
import { piModelServer } from "./helpers/pi-model-server.js";

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
