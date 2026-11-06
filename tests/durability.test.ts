import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { AgentInput } from "../src/chat/agent.js";
import { callWorker } from "../src/worker/client.js";
import { workerActionForDesktop } from "../src/desktop/ipc/session.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { resultSchema } from "../src/shared/core.js";
import { routineEventSchema } from "../src/shared/routines.js";
import {
  backupDatabase,
  restoreDatabase,
} from "../src/storage/backup/backup.js";
import { Store } from "../src/storage/store.js";
import { startWorker } from "../src/worker/server.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

function command(command: Command) {
  return envelopeSchema.parse({ id: randomUUID(), command });
}

await test("an open database backup restores attachment bytes onto an isolated file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-backup-"));
  const store = new Store(join(directory, "aster.sqlite"));
  try {
    const created = store.execute(
      command({ type: "bot.create", name: "Backup", description: "" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    const bytes = Buffer.from("attachment-kept");
    const attachment = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "note.txt" },
      bytes,
    );
    const snapshotFile = join(directory, "snapshot.sqlite");
    await backupDatabase(join(directory, "aster.sqlite"), snapshotFile);
    store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "later.txt" },
      Buffer.from("after-backup"),
    );
    const restored = join(directory, "restored.sqlite");
    await restoreDatabase(snapshotFile, restored);
    const copy = new Store(restored);
    try {
      const kept = copy.files.attachmentContent(conversationId, attachment.id);
      assert.ok(Buffer.from(kept.bytes).equals(bytes));
      assert.equal(
        copy.views.snapshot({ conversationId }).conversations[0]
          ?.draftAttachments.length,
        1,
      );
    } finally {
      copy.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("closing the window leaves an accepted run, and a crash is not resent", async () => {
  assert.equal(workerActionForDesktop("window-closed"), "leave-running");
  assert.equal(workerActionForDesktop("quit-ui"), "leave-running");
  assert.equal(workerActionForDesktop("worker-stop"), "stop");
  const directory = await mkdtemp(join(tmpdir(), "aster-ui-close-"));
  let started: (input: AgentInput) => void = () => {};
  const running = new Promise<AgentInput>((resolve) => {
    started = resolve;
  });
  const worker = await startWorker(directory, {
    port: 0,
    agent: {
      check: async () => ({ accountType: "fixture", detail: "held run" }),
      run: async (input) => {
        started(input);
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return { status: "cancelled", error: null };
      },
    },
  });
  try {
    const bot = resultSchema.parse(
      await callWorker(worker.endpoint, "/command", {
        id: randomUUID(),
        command: { type: "bot.create", name: "Held", description: "" },
      }),
    );
    assert.ok(bot.conversationId);
    await callWorker(worker.endpoint, "/command", {
      id: randomUUID(),
      command: {
        type: "message.send",
        conversationId: bot.conversationId,
        text: "keep going",
      },
    });
    await running;
    const health = (await callWorker(worker.endpoint, "/health")) as {
      pid: number;
    };
    assert.equal(health.pid, worker.endpoint.pid);
    const view = await workerSnapshot(worker.endpoint, {
      conversationId: bot.conversationId,
    });
    assert.equal(view.runs[0]?.status, "running");
    assert.equal(view.messages.length, 1);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }

  const crashed = await mkdtemp(join(tmpdir(), "aster-crash-"));
  let store = new Store(join(crashed, "aster.sqlite"));
  try {
    const conversationId = store.execute(
      command({ type: "bot.create", name: "Crash", description: "" }),
    ).conversationId;
    assert.ok(conversationId);
    store.execute(
      command({ type: "message.send", conversationId, text: "once" }),
    );
    assert.ok(store.runs.claim());
    const before = store.views.snapshot({ conversationId });
    store.close();
    store = new Store(join(crashed, "aster.sqlite"));
    store.recover();
    const after = store.views.snapshot({ conversationId });
    assert.equal(after.runs.length, before.runs.length);
    assert.equal(after.runs[0]?.status, "unknown");
    assert.match(after.runs[0]?.error ?? "", /不会自动重新发送/);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0]?.text, "once");
    assert.equal(store.runs.claim(), undefined);
  } finally {
    store.close();
    await rm(crashed, { recursive: true, force: true });
  }
});

await test("a webhook receipt stays distinct until the triggered run finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-webhook-finish-"));
  let seen = "";
  const worker = await startWorker(directory, {
    port: 0,
    agent: {
      check: async () => ({ accountType: "fixture", detail: "webhook" }),
      run: async (input) => {
        seen = input.text;
        await new Promise((resolve) => setImmediate(resolve));
        input.onEvent({
          type: "text",
          itemId: "reply",
          text: "WEBHOOK_DONE",
          complete: true,
        });
        return { status: "completed", error: null };
      },
    },
  });
  const base = `http://127.0.0.1:${worker.endpoint.port}`;
  const send = async (command: Command) => {
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.endpoint.token}` },
      body: JSON.stringify({ id: randomUUID(), command }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { id?: string; conversationId?: string };
  };
  try {
    const bot = await send({
      type: "bot.create",
      name: "Hook",
      description: "",
    });
    assert.ok(bot.id);
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const target = { botId: bot.id, id };
    await send({
      type: "routine.save",
      ...target,
      revision: 0,
      name: "Inbound",
      prompt: "Read the external event",
      schedule: { kind: "webhook" },
    });
    await send({
      type: "routine.key",
      ...target,
      revision: 1,
      hash: createHash("sha256").update(token).digest("hex"),
    });
    await send({
      type: "routine.state",
      ...target,
      revision: 2,
      state: "active",
    });
    const response = await fetch(`${base}/webhooks/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventId: "evt-1",
        timestamp: Date.now(),
        text: "payload-42",
      }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 202);
    const accepted = z
      .object({ accepted: z.literal(true), event: routineEventSchema })
      .parse(await response.json()).event;
    assert.equal(accepted.status, "queued");
    assert.ok(accepted.runId);
    assert.ok(accepted.conversationId);
    let finished = accepted;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && finished.status !== "completed") {
      const follow = await fetch(
        `${base}/webhooks/${id}/events/${accepted.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(follow.status, 200);
      finished = routineEventSchema.parse(await follow.json());
      if (finished.status !== "completed")
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finished.id, accepted.id);
    assert.equal(finished.runId, accepted.runId);
    assert.equal(finished.status, "completed");
    assert.match(seen, /payload-42/);
    const view = await workerSnapshot(worker.endpoint, {
      conversationId: accepted.conversationId,
    });
    assert.equal(
      view.messages.some((message) => message.text === "WEBHOOK_DONE"),
      true,
    );
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
