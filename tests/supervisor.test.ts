import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { callWorker, connectWorker, readWorker } from "../src/worker/client.js";
import { readSupervisionDiagnostics } from "../src/diagnostics/supervision.js";
import type { Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";
import { RestartBudget } from "../src/worker/supervisor.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

const command = (command: Command) => ({
  id: randomUUID(),
  command,
});

await test("a stop committed before readiness resolves only the just-spawned worker generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-stop-before-ready-"));
  try {
    // Transport timing fixture: publish a stopped child record, never send ready.
    // The full supervisor test below exercises the actual worker/HTTP/database.
    const childPath = join(directory, "stopped-child.mjs");
    await writeFile(
      childPath,
      `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.ASTER_DATA_DIR, id=process.env.ASTER_SUPERVISION_ID;
writeFileSync(join(dir,'endpoint.json'),JSON.stringify({version:21,port:12345,token:'a'.repeat(64),pid:process.pid,supervisionId:id}));
writeFileSync(join(dir,'worker-stop-'+id+'.json'),JSON.stringify({version:1,id}));
process.disconnect();`,
    );
    const id = randomUUID();
    const stopped = await connectWorker(directory, childPath, id);
    assert.equal(stopped.supervisionId, id);
    await writeFile(
      childPath,
      (await readFile(childPath, "utf8")).replace(
        "pid:process.pid",
        "pid:process.pid+1000000",
      ),
    );
    await assert.rejects(connectWorker(directory, childPath, randomUUID()), {
      code: "conflict",
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
async function eventually<T>(
  read: () => Promise<T | undefined>,
  milliseconds = 15000,
): Promise<T> {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("state did not converge within deadline");
}

await test("supervisor crash backoff is bounded and resets only after the five-minute window", () => {
  const budget = new RestartBudget();
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) => budget.nextDelay(i * 1000)),
    [500, 1000, 2000, 4000, 8000],
  );
  assert.equal(budget.nextDelay(5000), null);
  assert.equal(budget.nextDelay(299999), null);
  assert.equal(budget.nextDelay(304001), 500);
});

await test("supervision diagnostics retain bounded status, identify expired heartbeats and omit private details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-supervision-report-"));
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await readSupervisionDiagnostics(directory, signal), {
      available: false,
      reason: "not_enabled",
    });
    const marker = {
      version: 1,
      id: randomUUID(),
      pid: process.pid,
      workerPid: process.pid,
      state: "running",
      restarts: 2,
      detail: "PRIVATE_CANARY_DO_NOT_EXPORT",
      updatedAt: Date.now() - 60000,
    };
    await writeFile(join(directory, "supervisor.json"), JSON.stringify(marker));
    const report = await readSupervisionDiagnostics(directory, signal);
    assert.ok(report.available);
    assert.equal(report.stale, true);
    assert.equal(report.restarts, 2);
    assert.ok(!JSON.stringify(report).includes("PRIVATE_CANARY"));
    assert.ok(!JSON.stringify(report).includes(marker.id));
    await writeFile(join(directory, "supervisor.json"), "x".repeat(8193));
    assert.deepEqual(await readSupervisionDiagnostics(directory, signal), {
      available: false,
      reason: "invalid_record",
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      readSupervisionDiagnostics(directory, cancelled.signal),
      { name: "AbortError" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test(
  "real supervisor recovers a killed worker without replaying unknown work, and exits after authenticated user stop",
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-supervisor-"));
    await mkdir(localWorkspaceDirectory(directory), { recursive: true });
    const store = new Store(
      join(localWorkspaceDirectory(directory), "aster.sqlite"),
    );
    const bot = store.execute(
      command({ type: "bot.create", name: "Durable", description: "" }),
    );
    assert.ok(bot.conversationId);
    store.execute(
      command({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "seeded interrupted input",
      }),
    );
    const claimed = store.runs.claim();
    assert.ok(claimed);
    store.close();
    let endpoint: Awaited<ReturnType<typeof readWorker>> | undefined;
    let stopped = false;
    try {
      const [first, contender] = await Promise.all([
        connectWorker(directory, resolve("dist/worker/supervisor-main.js")),
        connectWorker(directory, resolve("dist/worker/supervisor-main.js")),
      ]);
      endpoint = first;
      assert.equal(first.pid, contender.pid);
      assert.ok(first.supervisionId);
      const initial = await workerSnapshot(first);
      assert.equal(initial.bots[0]?.name, "Durable");
      // The child belongs to this isolated test and has not sent any model request.
      process.kill(first.pid, "SIGKILL");
      endpoint = await eventually(async () => {
        try {
          const next = await readWorker(directory);
          return next.pid !== first.pid ? next : undefined;
        } catch {
          return undefined;
        }
      });
      assert.equal(endpoint.supervisionId, first.supervisionId);
      const recovered = await workerSnapshot(endpoint, {
        conversationId: bot.conversationId,
      });
      assert.equal(recovered.bots[0]?.name, "Durable");
      await callWorker(endpoint, "/command", command({ type: "worker.stop" }));
      const status = await eventually(async () => {
        const value = z
          .object({
            state: z.string(),
            restarts: z.number(),
            workerPid: z.number(),
          })
          .parse(
            JSON.parse(
              await readFile(join(directory, "supervisor.json"), "utf8"),
            ),
          );
        return value.state === "stopped" ? value : undefined;
      });
      stopped = true;
      assert.equal(status.restarts, 1);
      assert.equal(status.workerPid, endpoint.pid);
      await assert.rejects(readWorker(directory));
      const reopened = new Store(
        join(localWorkspaceDirectory(directory), "aster.sqlite"),
      );
      try {
        const view = reopened.views.snapshot({
          conversationId: bot.conversationId,
        });
        assert.equal(view.messages.filter((m) => m.role === "user").length, 1);
        assert.equal(reopened.runs.getRun(claimed.id)?.status, "unknown");
      } finally {
        reopened.close();
      }
    } finally {
      if (endpoint && !stopped) {
        console.error(
          "supervisor failure state",
          await readFile(join(directory, "supervisor.json"), "utf8"),
        );
        try {
          const current = await readWorker(directory);
          await callWorker(
            current,
            "/command",
            command({ type: "worker.stop" }),
          );
        } catch (error) {
          console.error(
            "supervisor test cleanup could not confirm worker stop",
            error instanceof Error ? error.name : "Error",
          );
        }
        await eventually(async () => {
          const value = z
            .object({ state: z.string() })
            .parse(
              JSON.parse(
                await readFile(join(directory, "supervisor.json"), "utf8"),
              ),
            );
          return value.state === "stopped" || value.state === "failed"
            ? true
            : undefined;
        });
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },
);
