import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "../src/chat/agent.js";
import { DeletionService } from "../src/deletion/service.js";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

await test("deletion uses the injected Agent cleanup and retains evidence when its cleanup capability is absent", async () => {
  for (const supported of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "aster-deletion-agent-"));
    const workspaceRoot = join(directory, "workspaces");
    await mkdir(workspaceRoot);
    const store = new Store(join(directory, "db.sqlite"));
    const execute = (command: Command) =>
      store.execute({
        id: randomUUID(),
        command,
      });
    const bot = execute({
      type: "bot.create",
      name: "custom Agent",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "x",
    });
    const job = store.runs.claim();
    assert.ok(job);
    store.runs.setThread(job, "custom-agent-thread");
    store.runs.finish(job.id, "completed", null);
    const workspace = join(workspaceRoot, bot.id);
    await mkdir(workspace);
    const evidence = join(workspace, "custom-session.txt");
    await writeFile(evidence, "keep until Agent acknowledges");
    let calls = 0;
    const cleanup: Agent["cleanThreads"] = async (path, ids, signal, known) => {
      signal.throwIfAborted();
      assert.equal(path, workspace);
      assert.equal(ids, undefined);
      assert.ok(known?.includes("custom-agent-thread"));
      calls++;
    };
    const service = new DeletionService(
      store,
      { quiesce: async () => {} },
      { quiesce: async () => {} },
      workspaceRoot,
      supported ? cleanup : undefined,
    );
    try {
      const deletion = execute({
        type: "entity.delete",
        kind: "bot",
        targetId: bot.id,
        expectedName: "custom Agent",
      });
      assert.ok(deletion.id);
      service.wake();
      const until = Date.now() + 3000;
      while (
        Date.now() < until &&
        ["queued", "cleaning"].includes(
          store.views.snapshot({}).deletions.find((d) => d.id === deletion.id)
            ?.status ?? "",
        )
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const result = store.views
        .snapshot({})
        .deletions.find((d) => d.id === deletion.id);
      if (supported) {
        assert.equal(result, undefined); // Completed jobs are omitted from the snapshot.
        assert.equal(
          store.views.snapshot({}).bots.find((b) => b.id === bot.id)?.lifecycle,
          "deleted",
        );
        await assert.rejects(readFile(evidence), { code: "ENOENT" });
      } else assert.equal(result?.status, "failed");
      assert.equal(calls, supported ? 1 : 0);
      if (!supported) {
        assert.match(result?.error ?? "", /Agent/);
        assert.equal(
          await readFile(evidence, "utf8"),
          "keep until Agent acknowledges",
        );
      }
    } finally {
      await service.stop();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
