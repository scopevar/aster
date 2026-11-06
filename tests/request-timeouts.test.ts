import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { ToolService } from "../src/tools/service.js";
import { SandboxProcess } from "../src/sandbox/process.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { workerRoutes } from "../src/shared/protocol.js";
import { callWorker } from "../src/worker/client.js";
import { startWorker } from "../src/worker/server.js";

for (const route of [workerRoutes.toolsScripts, workerRoutes.toolsPlugins]) {
  for (const outcome of ["approve", "stop"] as const) {
    await test(`${route} waits beyond the ordinary deadline, then handles ${outcome}`, async (t) => {
      // Resource downloading is external to this HTTP deadline contract. Its real timers
      // must not straddle this test's global mocked clock or trigger public downloads.
      t.mock.method(SandboxProcess.prototype, "prepare", async () => {});
      const directory = await mkdtemp(join(tmpdir(), "aster-request-timeout-"));
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      let entered: () => void = () => {};
      const admitted = new Promise<void>((accept) => {
        entered = accept;
      });
      let approvalSignal: AbortSignal | undefined;
      let release: () => void = () => {};
      const waiting = (
        _token: string,
        _input: unknown,
        signal: AbortSignal,
      ) => {
        approvalSignal = signal;
        entered();
        return new Promise<{ status: "completed"; detail: string }>(
          (accept, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            release = () => {
              signal.removeEventListener("abort", abort);
              accept({ status: "completed", detail: "approved" });
            };
          },
        );
      };
      t.mock.method(
        ToolService.prototype,
        route === workerRoutes.toolsScripts ? "scripts" : "plugins",
        waiting,
      );
      let responseStatus: number | undefined;
      let finished: () => void = () => {};
      const complete = new Promise<void>((accept) => {
        finished = accept;
      });
      const worker = await startWorker(directory, {
        port: 0,
        agent: {
          check: async () => ({ accountType: null, detail: "fixture" }),
          async run(input) {
            assert.ok(input.toolAccess);
            try {
              const response = await fetch(
                `http://127.0.0.1:${input.toolAccess.port}${route}`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${input.toolAccess.token}`,
                  },
                  body: JSON.stringify({
                    callId: "approval",
                    action: { type: "type", text: "approval" },
                  }),
                  signal: input.signal,
                },
              );
              responseStatus = response.status;
              await response.text();
              return { status: "completed", error: null };
            } finally {
              finished();
            }
          },
        },
      });
      const execute = (command: Command) =>
        callWorker(worker.endpoint, workerRoutes.command, {
          id: randomUUID(),
          command,
        });
      try {
        const bot = await execute({
          type: "bot.create",
          name: "审批",
          description: "",
        });
        const created = resultSchema.parse(bot);
        assert.ok(created.conversationId);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        await execute({
          type: "message.send",
          conversationId: created.conversationId,
          text: "等待审批",
        });
        await admitted;
        t.mock.timers.tick(36_000);
        if (route === workerRoutes.toolsScripts) t.mock.timers.tick(9 * 60_000);
        assert.equal(approvalSignal?.aborted, false);
        if (outcome === "approve") {
          release();
          await complete;
          assert.equal(responseStatus, 200);
        } else {
          await worker.stop();
          await complete;
          assert.equal(approvalSignal?.aborted, true);
        }
      } finally {
        release();
        t.mock.timers.reset();
        await worker.stop();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
