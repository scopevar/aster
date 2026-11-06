import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ServerResponse } from "node:http";
import { AgentConnections } from "../src/agent/connections.js";
import { JevClient } from "../src/agent/jev.js";
import { SandboxService } from "../src/sandbox/service.js";
import { SandboxProcess } from "../src/sandbox/process.js";
import { Store } from "../src/storage/store.js";
import { scriptResultSchema } from "../src/shared/tools/scripts.js";
import type { Command } from "../src/shared/commands.js";
import {
  jevAnswer,
  jevServer,
  type JevWireRequest,
} from "./helpers/jev-server.js";

// Real Session -> SQLite -> Jev HTTP owns the permission contract. Only credentials,
// the provider's answers and the VM are controlled; no approval behavior is mocked.
async function fixture(
  t: TestContext,
  respond: (request: JevWireRequest, response: ServerResponse) => void,
  userRequest = "请查一下北京天气。",
) {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "jev-approval-"));
  const store = new Store(":memory:");
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  const bot = execute({
    type: "bot.create",
    name: "审批验收",
    description: "",
  });
  assert.ok(bot.id && bot.conversationId);
  execute({
    type: "message.send",
    conversationId: bot.conversationId,
    text: userRequest,
  });
  const job = store.runs.claim();
  assert.ok(job);
  const remote = await jevServer(respond);
  const connections = new AgentConnections(join(root, "agent"));
  t.mock.method(
    connections,
    "scriptReviewer",
    async () => new JevClient(remote.config, "jev-fixture-key"),
  );
  let executions = 0;
  t.mock.method(SandboxProcess.prototype, "prepare", async () => {});
  t.mock.method(SandboxProcess.prototype, "open", async () => {});
  t.mock.method(SandboxProcess.prototype, "close", async () => {});
  t.mock.method(SandboxProcess.prototype, "execute", async () => {
    executions++;
    return {
      status: "completed" as const,
      stdout: "VM_EXECUTED",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      truncated: false,
    };
  });
  const sandbox = new SandboxService(store, root, connections);
  const controller = new AbortController();
  const scope = sandbox.open(job, controller.signal);
  const command =
    "python3 -c \"import urllib.request; print(urllib.request.urlopen('https://wttr.in/Beijing?format=j1').read()[:5000])\"";
  const request = (callId = "weather", text = command) =>
    scope.request(
      {
        callId,
        operation: { action: "exec", command: text, network: ["wttr.in"] },
      },
      new AbortController().signal,
    );
  const call = () => {
    const value = store
      .snapshotSince({ conversationId: job.conversationId })
      ?.messages.findLast((message) => message.computerTool)?.computerTool;
    assert.ok(value);
    return value;
  };
  return {
    store,
    job,
    remote,
    connections,
    controller,
    request,
    call,
    execute,
    executions: () => executions,
    async close() {
      await scope.close();
      await sandbox.stop();
      store.close();
      await remote.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "expected approval transition");
    await delay(10);
  }
}

await test("Jev reviews the exact user request and command before a single-use automatic approval", async (t) => {
  let answer: ServerResponse | undefined;
  const f = await fixture(t, (_request, response) => {
    answer = response;
  });
  try {
    const pending = f.request();
    await until(() => !!answer);
    assert.equal(f.call().review?.state, "reviewing");
    assert.equal(f.executions(), 0);
    const state: unknown = f.remote.requests[0]?.state;
    assert.match(JSON.stringify(state), /请查一下北京天气/);
    assert.match(JSON.stringify(state), /wttr.in\/Beijing/);
    assert.doesNotMatch(JSON.stringify(state), /jev-fixture-key/);
    assert.ok(answer);
    jevAnswer(answer, "public_read");
    const result = scriptResultSchema.parse(await pending);
    assert.equal(result.action, "exec");
    if (result.action === "exec")
      assert.equal(result.result.stdout, "VM_EXECUTED");
    assert.equal(f.call().review?.decision, "allow");
    assert.equal(f.call().review?.reviewer, "jev");
    assert.equal(f.call().status, "completed");
    assert.deepEqual(await f.request(), result);
    assert.equal(f.executions(), 1);
    assert.equal(f.remote.requests.length, 1);
    assert.throws(() => f.request("weather", "echo changed"), /不能更改参数/);
  } finally {
    await f.close();
  }
});

for (const mode of [
  "ask",
  "low-confidence",
  "invalid",
  "http-error",
  "disabled",
  "inconsistent",
] as const) {
  await test(`Jev ${mode} returns the exact pending call to its user without executing it`, async (t) => {
    const f = await fixture(t, (_request, response) => {
      if (mode === "inconsistent") {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            answers: {
              next: {
                type: "choice",
                choice: "public_read",
                confidence: 1,
                probabilities: { public_read: 0.1, ask: 0.9 },
              },
            },
          }),
        );
      } else if (mode === "http-error") {
        response.writeHead(401);
        response.end("secret provider body");
      } else if (mode === "invalid") jevAnswer(response, "invented-approval");
      else
        jevAnswer(
          response,
          mode === "ask" ? "ask" : "public_read",
          mode === "low-confidence" ? 0.5 : 1,
        );
    });
    if (mode === "disabled")
      t.mock.method(f.connections, "scriptReviewer", async () => undefined);
    try {
      const pending = f.request();
      await until(() => f.call().review?.state === "decided");
      assert.equal(f.call().status, "pending");
      assert.equal(f.call().review?.decision, "ask");
      assert.equal(f.executions(), 0);
      assert.doesNotMatch(
        f.call().detail,
        /secret provider body|jev-fixture-key/,
      );
      f.execute({
        type: "tool.decide",
        id: f.call().id,
        conversationId: f.job.conversationId,
        decision: "allow",
      });
      const result = scriptResultSchema.parse(await pending);
      assert.equal(result.action, "exec");
      if (result.action === "exec")
        assert.equal(result.result.status, "completed");
      assert.equal(f.call().review?.state, "manual");
      assert.equal(f.executions(), 1);
    } finally {
      await f.close();
    }
  });
}

await test("manual refusal cancels an in-flight Jev request and a late allow cannot override it", async (t) => {
  let answer: ServerResponse | undefined,
    disconnected = false;
  const f = await fixture(t, (_request, response) => {
    answer = response;
    response.once("close", () => {
      disconnected = true;
    });
  });
  try {
    const pending = f.request();
    await until(() => !!answer);
    const id = f.call().id;
    f.execute({
      type: "tool.decide",
      id,
      conversationId: f.job.conversationId,
      decision: "decline",
    });
    const result = scriptResultSchema.parse(await pending);
    assert.equal(result.action, "exec");
    if (result.action === "exec")
      assert.equal(result.result.status, "declined");
    await until(() => disconnected);
    f.store.toolOperations.toolReviewFinish(f.job, id, {
      decision: "allow",
      reason: "late",
    });
    assert.equal(f.call().status, "declined");
    assert.equal(f.call().review?.state, "manual");
    assert.equal(f.call().review?.decision, "deny");
    assert.equal(f.executions(), 0);
  } finally {
    await f.close();
  }
});

await test("cancelling a reviewing script aborts the provider and prevents a late execution", async (t) => {
  let entered = false,
    disconnected = false;
  const f = await fixture(t, (_request, response) => {
    entered = true;
    response.once("close", () => {
      disconnected = true;
    });
  });
  try {
    const pending = f.request();
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await until(() => entered);
    f.controller.abort();
    await rejected;
    await until(() => disconnected);
    f.store.toolOperations.toolReviewFinish(f.job, f.call().id, {
      decision: "allow",
      reason: "late",
    });
    assert.equal(f.call().status, "cancelled");
    assert.equal(f.call().review?.state, "abandoned");
    assert.equal(f.executions(), 0);
  } finally {
    await f.close();
  }
});

await test("expired Jev results cannot approve a script", async (t) => {
  let answer: ServerResponse | undefined;
  const f = await fixture(t, (_request, response) => {
    answer = response;
  });
  try {
    const pending = f.request();
    await until(() => !!answer);
    t.mock.timers.enable({ apis: ["Date"], now: f.call().expiresAt + 1 });
    assert.ok(answer);
    jevAnswer(answer, "public_read");
    const result = scriptResultSchema.parse(await pending);
    assert.equal(result.action, "exec");
    if (result.action === "exec") assert.equal(result.result.status, "expired");
    assert.equal(f.executions(), 0);
    assert.equal(f.call().review?.state, "abandoned");
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

await test("Jev review time counts toward the original approval deadline", async (t) => {
  let answer: ServerResponse | undefined;
  const f = await fixture(t, (_request, response) => {
    answer = response;
  });
  try {
    const pending = f.request();
    void pending.catch(() => {});
    await until(() => !!answer);
    const decided = new Promise<void>((resolve) => {
      const unsubscribe = f.store.subscribe(() => {
        if (f.call().review?.state !== "decided") return;
        unsubscribe();
        resolve();
      });
    });
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.now() + 10000,
    });
    assert.ok(answer);
    jevAnswer(answer, "ask");
    await decided;
    await nextTurn();
    assert.equal(f.call().status, "pending");
    t.mock.timers.tick(f.call().expiresAt - Date.now() + 1);
    assert.equal(f.call().status, "expired");
    const result = scriptResultSchema.parse(await pending);
    assert.equal(result.action, "exec");
    if (result.action === "exec") assert.equal(result.result.status, "expired");
    assert.equal(f.executions(), 0);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

await test(
  "Jev timeout falls back to manual approval and closes the HTTP request",
  { timeout: 25000 },
  async (t) => {
    let disconnected = false;
    const f = await fixture(t, (_request, response) => {
      response.once("close", () => {
        disconnected = true;
      });
    });
    try {
      const pending = f.request();
      const end = Date.now() + 20000;
      while (f.call().review?.state !== "decided") {
        assert.ok(Date.now() < end);
        await delay(25);
      }
      await until(() => disconnected);
      assert.equal(f.call().status, "pending");
      assert.equal(f.executions(), 0);
      f.execute({
        type: "tool.decide",
        id: f.call().id,
        conversationId: f.job.conversationId,
        decision: "decline",
      });
      await pending;
    } finally {
      await f.close();
    }
  },
);

await test("oversized review context goes to the user without sending a truncated request", async (t) => {
  const f = await fixture(
    t,
    (_request, response) => jevAnswer(response, "public_read"),
    "a".repeat(32000),
  );
  try {
    const pending = f.request("large", "echo " + "b".repeat(32760));
    await until(() => f.call().review?.state === "decided");
    assert.match(f.call().detail, /超过.*审核范围/);
    assert.equal(f.remote.requests.length, 0);
    assert.equal(f.executions(), 0);
    f.execute({
      type: "tool.decide",
      id: f.call().id,
      conversationId: f.job.conversationId,
      decision: "decline",
    });
    await pending;
  } finally {
    await f.close();
  }
});

await test("a review cannot grant a different Bot's pending command", async (t) => {
  let entered = false;
  const f = await fixture(t, () => {
    entered = true;
  });
  try {
    const pending = f.request();
    await until(() => entered);
    const other = f.execute({
      type: "bot.create",
      name: "Other",
      description: "",
    });
    assert.ok(other.conversationId);
    f.execute({
      type: "message.send",
      conversationId: other.conversationId,
      text: "other task",
    });
    const otherJob = f.store.runs.claim();
    assert.ok(otherJob);
    assert.throws(
      () =>
        f.store.toolOperations.toolReviewFinish(otherJob, f.call().id, {
          decision: "allow",
          reason: "wrong owner",
        }),
      /不属于当前运行/,
    );
    assert.equal(f.call().review?.state, "reviewing");
    f.execute({
      type: "tool.decide",
      id: f.call().id,
      conversationId: f.job.conversationId,
      decision: "decline",
    });
    await pending;
    assert.equal(f.executions(), 0);
  } finally {
    await f.close();
  }
});

await test("startup recovery abandons an unfinished Jev review and rejects its old result", async () => {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "jev-recovery-"));
  const path = join(directory, "aster.sqlite");
  let store = new Store(path);
  try {
    const execute = (command: Command) =>
      store.execute({ id: randomUUID(), command });
    const bot = execute({
      type: "bot.create",
      name: "Recovery",
      description: "",
    });
    assert.ok(bot.conversationId);
    execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "process input",
    });
    const job = store.runs.claim();
    assert.ok(job);
    const call = store.toolOperations.toolRequest(
      job,
      "crash",
      { type: "script", command: "echo proof", network: [] },
      true,
    );
    assert.equal(call.review?.state, "reviewing");
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(store.toolOperations.toolGet(call.id).status, "cancelled");
    assert.equal(
      store.toolOperations.toolGet(call.id).review?.state,
      "abandoned",
    );
    store.toolOperations.toolReviewFinish(job, call.id, {
      decision: "allow",
      reason: "before crash",
    });
    assert.equal(store.toolOperations.toolGet(call.id).status, "cancelled");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
