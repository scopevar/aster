import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { daemonStatus, stopDaemon } from "../../daemon/lifecycle.js";
import { callWorker } from "../../worker/client.js";
import { workerRoutes } from "../../shared/protocol.js";
import { updatePreparationStateSchema } from "../../shared/update-preparation.js";
import { AppError } from "../../shared/core.js";

export async function prepareUpdateBackground(input: {
  directory: string;
  signal: AbortSignal;
  waiting(message: string): void;
  installing(): void;
}) {
  const endpoint = await daemonStatus(input.directory);
  input.signal.throwIfAborted();
  if (!endpoint) {
    input.installing();
    return;
  }
  const id = randomUUID();
  let stopped = false;
  try {
    let action: "begin" | "poll" = "begin";
    for (;;) {
      input.signal.throwIfAborted();
      const state = updatePreparationStateSchema.parse(
        await callWorker(
          endpoint,
          workerRoutes.updatePreparation,
          { action, id },
          input.signal,
          5000,
        ),
      );
      input.signal.throwIfAborted();
      if (state.ready) break;
      input.waiting(
        `正在等待${state.waiting.join("、")}结束。可取消更新，继续使用。`,
      );
      await delay(500, undefined, { signal: input.signal });
      action = "poll";
    }
    input.installing();
    await stopDaemon(input.directory, 30000, id);
    stopped = true;
  } finally {
    if (!stopped) {
      try {
        await callWorker(
          endpoint,
          workerRoutes.updatePreparation,
          { action: "cancel", id },
          undefined,
          5000,
        );
      } catch {
        throw new AppError(
          "unavailable",
          "更新未完成，暂时无法确认后台状态；请检查后台后重试。",
        );
      }
    }
  }
}
