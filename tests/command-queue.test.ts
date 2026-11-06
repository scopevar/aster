import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandQueue } from "../src/ui/lib/command-queue.js";
import type { DesktopCommand as Command } from "../src/shared/desktop/desktop-commands.js";

await test("draft bursts coalesce while sends form barriers and retain newer drafts", async () => {
  const sent: Command[] = [];
  const queue = new CommandQueue(async (command) => {
    sent.push(command);
    return {};
  });
  const tasks = Array.from({ length: 100 }, (_, n) =>
    queue.submit({ type: "draft.save", conversationId: "a", text: String(n) }),
  );
  tasks.push(
    queue.submit({ type: "message.send", conversationId: "a", text: "99" }),
  );
  tasks.push(
    queue.submit({ type: "draft.save", conversationId: "a", text: "next" }),
  );
  queue.flush();
  await Promise.all(tasks);
  assert.deepEqual(sent, [
    { type: "draft.save", conversationId: "a", text: "99" },
    { type: "message.send", conversationId: "a", text: "99" },
    { type: "draft.save", conversationId: "a", text: "next" },
  ]);
});
await test("draft failures reach all waiters and do not block later commands", async () => {
  let calls = 0;
  const queue = new CommandQueue(async () => {
    if (++calls === 1) throw new Error("disk failure");
    return {};
  });
  const first = queue.submit({
    type: "draft.save",
    conversationId: "a",
    text: "1",
  });
  const second = queue.submit({
    type: "draft.save",
    conversationId: "a",
    text: "2",
  });
  const failures = Promise.all([
    assert.rejects(first, /disk failure/),
    assert.rejects(second, /disk failure/),
  ]);
  await queue.submit({ type: "message.send", conversationId: "a", text: "2" });
  await failures;
  assert.equal(calls, 2);
});
await test("explicit idempotency envelopes and different conversations are not coalesced", async () => {
  const sent: Command[] = [];
  const queue = new CommandQueue(async (command) => {
    sent.push(command);
    return {};
  });
  const one: Command = { type: "draft.save", conversationId: "a", text: "a" };
  await queue.submit(one, { id: "explicit", command: one });
  const two = queue.submit({
    type: "draft.save",
    conversationId: "a",
    text: "b",
  });
  const three = queue.submit({
    type: "draft.save",
    conversationId: "b",
    text: "c",
  });
  queue.flush();
  await Promise.all([two, three]);
  assert.equal(sent.length, 3);
});
