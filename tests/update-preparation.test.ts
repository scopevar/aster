import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentInput, AgentResult } from "../src/chat/agent.js";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import { resultSchema } from "../src/shared/core.js";
import type { Command } from "../src/shared/commands.js";
import { updatePreparationStateSchema } from "../src/shared/update-preparation.js";

// Owns the real HTTP admission, scheduler and Runtime boundary: a hidden routine
// keeps the update waiting, scoped tools remain available, and cancellation
// releases queued work without cancelling the current run or replaying it.
await test("update preparation drains hidden work and cancel resumes the queue", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "update-"));
  const running: AgentInput[] = [];
  const complete: Array<(result: AgentResult) => void> = [];
  const worker = await startWorker(directory, {
    port: 0,
    agent: {
      check: async () => ({ accountType: "fixture", detail: "held model" }),
      run: async (input) => {
        running.push(input);
        return new Promise<AgentResult>((resolve) => {
          complete.push(resolve);
          const abort = () => resolve({ status: "cancelled", error: null });
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
  });
  const command = async (command: Command) =>
    resultSchema.parse(
      await callWorker(worker.endpoint, "/command", {
        id: randomUUID(),
        command,
      }),
    );
  const id = randomUUID();
  const prepare = async (action: "begin" | "poll" | "cancel") =>
    updatePreparationStateSchema.parse(
      await callWorker(worker.endpoint, "/update-preparation", { action, id }),
    );
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, "observable state was not reached");
      await delay(10);
    }
  };
  let db: DatabaseSync | undefined;
  try {
    const bot = await command({
      type: "bot.create",
      name: "Update",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    const routineId = randomUUID();
    await command({
      type: "routine.save",
      id: routineId,
      botId: bot.id,
      revision: 0,
      name: "Hidden",
      prompt: "Quiet background work",
      schedule: { kind: "webhook" },
    });
    const routine = await command({
      type: "routine.test",
      id: routineId,
      botId: bot.id,
      revision: 1,
    });
    await until(() => running.length === 1);
    const queued = await command({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "queued",
    });
    assert.ok(queued.id && routine.conversationId);
    db = new DatabaseSync(join(directory, "local", "aster.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      db
        .prepare("SELECT hidden FROM conversations WHERE id=?")
        .get(routine.conversationId)?.hidden,
      1,
    );
    assert.equal(
      db.prepare("SELECT status FROM runs WHERE id=?").get(queued.id)?.status,
      "queued",
    );
    await assert.rejects(
      callWorker(worker.endpoint, "/update-preparation", {
        action: "begin",
        id: "invalid",
      }),
    );
    const waiting = await prepare("begin");
    assert.equal(waiting.ready, false);
    assert.match(waiting.waiting.join(""), /1 个会话或后台任务/);
    await assert.rejects(
      command({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "late",
      }),
      /准备更新/,
    );
    await assert.rejects(
      callWorker(worker.endpoint, "/update-preparation", {
        action: "begin",
        id: randomUUID(),
      }),
      /已有控制端/,
    );
    const input = running[0];
    assert.ok(input?.toolAccess);
    const scoped = {
      ...worker.endpoint,
      port: input.toolAccess.port,
      token: input.toolAccess.token,
    };
    await callWorker(scoped, "/tools/question", {
      callId: "during-update",
      question: { prompt: "Continue?", options: ["Yes", "No"] },
    });
    await command({
      type: "draft.save",
      conversationId: bot.conversationId,
      text: "kept draft",
    });
    assert.equal(input.signal.aborted, false);
    await assert.rejects(
      callWorker(worker.endpoint, "/update-preparation", {
        action: "stop",
        id,
      }),
      /未完成工作/,
    );
    await prepare("cancel");
    assert.equal(input.signal.aborted, false);
    await assert.rejects(
      callWorker(worker.endpoint, "/update-preparation", {
        action: "stop",
        id,
      }),
      /等待已结束/,
    );
    await prepare("begin");
    complete[0]?.({ status: "completed", error: null });
    await until(async () => (await prepare("poll")).ready);
    assert.equal(
      db.prepare("SELECT status FROM runs WHERE id=?").get(queued.id)?.status,
      "queued",
    );
    assert.equal(running.length, 1);
    await prepare("cancel");
    await until(() => running.length === 2);
    assert.equal(
      db.prepare("SELECT status FROM runs WHERE id=?").get(queued.id)?.status,
      "running",
    );
    assert.equal(running[0]?.signal.aborted, false);
  } finally {
    db?.close();
    for (const finish of complete) finish({ status: "completed", error: null });
    await worker.stop();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
