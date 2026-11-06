import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Store } from "../src/storage/store.js";
import { SandboxService } from "../src/sandbox/service.js";
import { ToolService } from "../src/tools/service.js";
import { readScriptFile } from "../src/sandbox/workspace.js";
import { scriptResultSchema } from "../src/shared/tools/scripts.js";
import type { Command } from "../src/shared/commands.js";

// Core contracts cover approval and file ownership. microsandbox.test.ts owns
// the real VM isolation, language, cancellation and lifecycle acceptance.
await test("script requests reject privilege expansion and require single-use approval without a desktop", async () => {
  const results = resolve(".runtime/test-results");
  await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(results, "scripts-core-"));
  const store = new Store(":memory:");
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  const bot = execute({ type: "bot.create", name: "Scripts", description: "" });
  assert.ok(bot.id && bot.conversationId);
  execute({
    type: "message.send",
    conversationId: bot.conversationId,
    text: "script",
  });
  const job = store.runs.claim();
  assert.ok(job);
  const sandbox = new SandboxService(store, root);
  const tools = new ToolService(store, 12345, undefined, undefined, sandbox);
  const scope = tools.open(job, new AbortController().signal);
  let overlapping: ReturnType<SandboxService["open"]> | undefined;
  const request = (callId: string, operation: unknown) =>
    tools.scripts(
      scope.connection.token,
      { callId, operation },
      new AbortController().signal,
    );
  try {
    for (const operation of [
      { action: "exec", command: "" },
      { action: "exec", command: "true\0false" },
      { action: "exec", command: "true", memory: 4096 },
      { action: "exec", command: "true", mounts: ["C:\\Users"] },
      { action: "exec", command: "true", image: "ubuntu:latest" },
      { action: "exec", command: "true", network: ["*.example.com"] },
      { action: "exec", command: "true", network: ["127.0.0.1"] },
      { action: "exec", command: "true", network: ["localhost"] },
    ])
      assert.throws(() => request(randomUUID(), operation));
    assert.throws(
      () =>
        tools.scripts(
          "invalid",
          { callId: "no", operation: { action: "status" } },
          new AbortController().signal,
        ),
      /授权已结束/,
    );
    overlapping = sandbox.open(job, new AbortController().signal);
    assert.equal(
      scriptResultSchema.parse(await request("status", { action: "status" }))
        .action,
      "status",
    );
    assert.throws(
      () =>
        overlapping?.request(
          { callId: "other", operation: { action: "status" } },
          new AbortController().signal,
        ),
      /另一轮使用/,
    );
    await overlapping.close();
    overlapping = undefined;
    const pending = request("declined", {
      action: "exec",
      command: "printf should-not-run > proof.txt",
    });
    const message = store
      .snapshotSince({ conversationId: job.conversationId })
      ?.messages.find((m) => m.computerTool?.action.type === "script");
    assert.ok(message?.computerTool);
    const call = message.computerTool;
    assert.equal(call.status, "pending");
    await assert.rejects(access(join(root, "scripts", "runtime")));
    execute({
      type: "tool.decide",
      id: call.id,
      conversationId: job.conversationId,
      decision: "decline",
    });
    const result = scriptResultSchema.parse(await pending);
    assert.equal(result.action, "exec");
    if (result.action === "exec")
      assert.equal(result.result.status, "declined");
    assert.throws(
      () => request("declined", { action: "exec", command: "printf changed" }),
      /不能更改参数/,
    );
    await assert.rejects(
      access(join(root, "workspaces", job.botId, "script-work", "proof.txt")),
    );
    assert.throws(
      () =>
        execute({
          type: "tool.decide",
          id: call.id,
          conversationId: job.conversationId,
          decision: "allow",
        }),
      /审批已经结束/,
    );
  } finally {
    await overlapping?.close();
    await scope.close();
    await sandbox.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("script export rejects host paths, traversal, hard links and directory junctions", async () => {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "script-export-"));
  const work = join(root, "work"),
    other = join(root, "other-bot");
  await mkdir(work);
  await mkdir(other);
  await writeFile(join(other, "private.txt"), "PRIVATE");
  await writeFile(join(work, "result.txt"), "WORK_RESULT");
  await link(join(other, "private.txt"), join(work, "hardlink.txt"));
  await symlink(
    other,
    join(work, "outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    assert.equal(
      (await readScriptFile(work, "result.txt")).toString(),
      "WORK_RESULT",
    );
    for (const path of [
      "../other-bot/private.txt",
      other,
      "C:\\Users\\private.txt",
      "outside/private.txt",
      "hardlink.txt",
    ])
      await assert.rejects(readScriptFile(work, path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
