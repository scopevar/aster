import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";

const command = (command: Command) => ({
  id: randomUUID(),
  command,
});
function bot(store: Store) {
  const created = store.execute(
    command({ type: "bot.create", name: "History", description: "" }),
  );
  assert.ok(created.conversationId);
  return created.conversationId;
}
function send(store: Store, conversationId: string, text: string) {
  store.execute(command({ type: "message.send", conversationId, text }));
  const job = store.runs.claim();
  assert.ok(job);
  return job;
}

await test("history pages all prior messages, reads full Unicode text, and excludes current, future and other conversations", () => {
  const store = new Store(":memory:");
  try {
    const conversationId = bot(store);
    const long = "😀".repeat(9000) + "END_HISTORY";
    const first = send(store, conversationId, "original");
    assert.equal(store.runs.historyContext(first), "");
    for (let i = 0; i < 24; i++)
      store.runs.output.writeText(
        first,
        `part-${i}`,
        i === 0 ? long : `archive-${i}`,
        true,
      );
    store.runs.finish(first.id, "completed", null);
    const other = bot(store);
    const otherJob = send(store, other, "PRIVATE_OTHER");
    const otherId = store.views.snapshot({ conversationId: other }).messages[0]!
      .id;
    store.runs.finish(otherJob.id, "completed", null);
    const job = send(store, conversationId, "CURRENT_EXCLUDED");
    store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "FUTURE_EXCLUDED",
      }),
    );
    assert.match(store.runs.historyContext(job), /fresh model session/);
    const page = store.runs.historyRequest(job, {
      operation: { action: "list" },
    });
    assert.ok(page.action === "list");
    assert.equal(page.messages.length, 20);
    assert.ok(page.nextBefore);
    const tail = store.runs.historyRequest(job, {
      operation: { action: "list", before: page.nextBefore },
    });
    assert.ok(tail.action === "list");
    assert.equal(tail.messages.length, 5);
    assert.equal(tail.nextBefore, null);
    assert.equal(
      new Set([...page.messages, ...tail.messages].map((m) => m.id)).size,
      25,
    );
    assert.doesNotMatch(
      JSON.stringify([page, tail]),
      /CURRENT_EXCLUDED|FUTURE_EXCLUDED|PRIVATE_OTHER/,
    );
    const found = store.runs.historyRequest(job, {
      operation: { action: "search", query: "END_HISTORY" },
    });
    assert.ok(found.action === "search");
    assert.equal(found.messages.length, 1);
    const id = found.messages[0]!.id;
    let offset = 0,
      restored = "";
    while (true) {
      const chunk = store.runs.historyRequest(job, {
        operation: { action: "read", id, offset },
      });
      assert.ok(chunk.action === "read");
      assert.equal(chunk.totalCharacters, long.length);
      restored += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    assert.equal(restored, long);
    assert.throws(
      () =>
        store.runs.historyRequest(job, {
          operation: { action: "read", id: otherId },
        }),
      /不属于/,
    );
    assert.throws(
      () =>
        store.runs.historyRequest(job, {
          operation: { action: "read", id, offset: long.length + 1 },
        }),
      /超过/,
    );
    store.runs.finish(job.id, "cancelled", null);
    assert.throws(
      () => store.runs.historyRequest(job, { operation: { action: "list" } }),
      /授权已结束/,
    );
  } finally {
    store.close();
  }
});

await test("history transport scope enforces a finite budget and revokes on cancellation and close", async () => {
  const store = new Store(":memory:");
  const tools = new ToolService(store, 39999);
  const controller = new AbortController();
  try {
    const job = send(store, bot(store), "read history");
    const scope = tools.open(job, controller.signal);
    const request = () =>
      tools.history(
        scope.connection.token,
        { operation: { action: "list" } },
        new AbortController().signal,
      );
    for (let i = 0; i < 128; i++) request();
    assert.throws(request, /128/);
    controller.abort();
    assert.throws(request, /授权已结束/);
    await scope.close();
    assert.throws(request, /授权已结束/);
  } finally {
    store.close();
  }
});
