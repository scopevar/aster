import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgent } from "../src/agent/pi.js";
import {
  openPiSession,
  cleanPiSessions,
  piSessionExists,
} from "../src/agent/pi-sessions.js";
import type { AgentEvent, AgentInput } from "../src/chat/agent.js";
import { piModelServer } from "./helpers/pi-model-server.js";

await test("actual Pi SDK streams, resumes exact sessions and isolates chats, members and accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-sdk-"));
  const model = await piModelServer();
  try {
    const workspace = join(root, "accounts", "a", "workspaces", "bot");
    const other = join(root, "accounts", "b", "workspaces", "bot");
    await mkdir(workspace, { recursive: true });
    await mkdir(other, { recursive: true });
    const agent = new PiAgent(join(root, "agent"), model.connection);
    const events: AgentEvent[] = [];
    const input: AgentInput = {
      workspace,
      sessionScope: { conversationId: randomUUID(), botId: "bot" },
      threadId: null,
      text: "first private message",
      instructions: "Allowed scoped tools only",
      signal: AbortSignal.timeout(10000),
      onEvent: (event) => events.push(event),
    };
    assert.equal((await agent.run(input)).status, "completed");
    assert.equal(
      events
        .flatMap((event) =>
          event.type === "text" && !event.complete ? [event.text] : [],
        )
        .join(""),
      "Hello Pi",
    );
    const thread = events.find((event) => event.type === "thread");
    assert.ok(thread?.type === "thread");
    assert.equal(await piSessionExists(thread.threadId, workspace), true);
    if (process.platform === "win32")
      assert.equal(
        (
          await openPiSession(
            workspace.toLowerCase(),
            input.sessionScope!.conversationId,
            thread.threadId,
          )
        ).threadId,
        thread.threadId,
      );
    assert.deepEqual(
      model.requests[0]?.tools,
      undefined,
      "No builtin or discovered tools",
    );
    assert.equal(
      model.headers[0]?.authorization,
      undefined,
      "anonymous local models do not receive an auth header",
    );
    input.threadId = thread.threadId;
    input.text = "second private message";
    assert.equal((await agent.run(input)).status, "completed");
    assert.ok(
      JSON.stringify(model.requests[1]?.messages).includes(
        "first private message",
      ),
    );
    const switched = new PiAgent(join(root, "agent"), {
      ...model.connection,
      provider: "second-provider",
      model: "alternate-model",
    });
    input.text = "new configuration, same conversation";
    assert.equal((await switched.run(input)).status, "completed");
    assert.equal(model.requests[2]?.model, "alternate-model");
    assert.ok(
      JSON.stringify(model.requests[2]?.messages).includes(
        "first private message",
      ),
    );
    await assert.rejects(
      openPiSession(workspace, randomUUID(), thread.threadId),
      /不属于/,
    );
    await assert.rejects(
      openPiSession(other, input.sessionScope!.conversationId, thread.threadId),
      /不属于/,
    );
    const secondChat = await openPiSession(workspace, randomUUID(), null);
    secondChat.manager.appendMessage({
      role: "user",
      content: "other conversation",
      timestamp: Date.now(),
    });
    await cleanPiSessions(
      workspace,
      [thread.threadId, "legacy-provider"],
      AbortSignal.timeout(5000),
    );
    assert.equal(await piSessionExists(thread.threadId, workspace), false);
    assert.equal(await piSessionExists(secondChat.threadId, workspace), true);
    assert.equal(
      await agent.requiresFreshSession(thread.threadId, workspace),
      true,
    );
    assert.equal(
      await agent.requiresFreshSession("legacy-provider", workspace),
      true,
    );
    const file = secondChat.manager.getSessionFile();
    assert.ok(file);
    assert.ok((await readFile(file, "utf8")).includes("other conversation"));
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
await test("actual Pi SDK cancellation closes an active model stream and never retries the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-cancel-"));
  const controller = new AbortController();
  const model = await piModelServer((_request, send) => {
    send({ role: "assistant", content: "started" });
  });
  try {
    const workspace = join(root, "bot");
    await mkdir(workspace);
    const agent = new PiAgent(root, model.connection);
    const result = await agent.run({
      workspace,
      sessionScope: { conversationId: randomUUID(), botId: "bot" },
      threadId: null,
      text: "cancel this",
      instructions: "",
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "text") controller.abort();
      },
    });
    assert.equal(result.status, "cancelled");
    assert.equal(model.requests.length, 1);
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
