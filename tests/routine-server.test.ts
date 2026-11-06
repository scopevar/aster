import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorker } from "../src/worker/server.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { routineEventSchema } from "../src/shared/routines.js";
import type { AgentInput } from "../src/chat/agent.js";
import { z } from "zod";

await test("actual webhook HTTP scopes credentials, admits one concurrent duplicate and cancels the owned runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-hook-http-"));
  let calls = 0;
  let ready: (input: AgentInput) => void = () => {};
  const started = new Promise<AgentInput>((resolve) => {
    ready = resolve;
  });
  // Controlled cancellation boundary only. No fabricated assistant output or inference success.
  const worker = await startWorker(directory, {
    port: 0,
    agent: {
      check: async () => ({
        accountType: "fixture",
        detail: "controlled cancellation",
      }),
      run: async (input) => {
        calls++;
        ready(input);
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
  const base = `http://127.0.0.1:${worker.endpoint.port}`;
  const command = async (command: Command) => {
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.endpoint.token}` },
      body: JSON.stringify({ id: randomUUID(), command }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return resultSchema.parse(await response.json());
  };
  try {
    const bot = await command({
      type: "bot.create",
      name: "HTTP",
      description: "",
    });
    assert.ok(bot.id);
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      url = `${base}/webhooks/${id}`;
    const target = { botId: bot.id, id };
    await command({
      type: "routine.save",
      ...target,
      revision: 0,
      name: "HTTP event",
      prompt: "Handle input",
      schedule: { kind: "webhook" },
    });
    await command({
      type: "routine.key",
      ...target,
      revision: 1,
      hash: createHash("sha256").update(token).digest("hex"),
    });
    await command({
      type: "routine.state",
      ...target,
      revision: 2,
      state: "active",
    });
    const input = {
      eventId: "same",
      timestamp: Date.now(),
      text: "real transport payload",
    };
    const post = (
      key: string,
      value: unknown = input,
      extra: Record<string, string> = {},
    ) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, ...extra },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(10000),
      });
    assert.equal((await post(worker.endpoint.token)).status, 401);
    assert.equal(
      (await post(token, input, { Origin: "https://untrusted.invalid" }))
        .status,
      401,
    );
    assert.equal(
      (await post(token, { ...input, timestamp: Date.now() - 300001 })).status,
      401,
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(token)),
    );
    const events = await Promise.all(
      responses.map(async (response) => {
        assert.equal(response.status, 202);
        return z
          .object({ accepted: z.literal(true), event: routineEventSchema })
          .parse(await response.json()).event;
      }),
    );
    assert.equal(new Set(events.map((event) => event.id)).size, 1);
    const running = await started;
    assert.match(running.text, /real transport payload/);
    assert.equal(calls, 1);
    assert.equal(
      (await post(token, { ...input, text: "different" })).status,
      400,
    );
    assert.equal(
      (await post(token, { ...input, text: "x".repeat(50000) })).status,
      400,
    );
    const event = events[0];
    assert.ok(event);
    const get = await fetch(`${url}/events/${event.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(get.status, 200);
    assert.equal(routineEventSchema.parse(await get.json()).status, "running");
    const main = await fetch(`${base}/routines?botId=${bot.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(main.status, 401);
    await command({
      type: "routine.state",
      ...target,
      revision: 3,
      state: "deleted",
    });
    assert.equal(running.signal.aborted, true);
    assert.equal((await post(token)).status, 401);
    assert.equal(calls, 1);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
