import { workerRoutes } from "../shared/protocol.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { connectWorker, readWorker, callWorker } from "./client.js";
import { ownDirectory } from "../platform/directory-lease.js";
import { publishEndpoint } from "../platform/publish-endpoint.js";
import { AppError } from "../shared/core.js";
import { stopMarker, stopWasRequested } from "./supervision.js";
import type { Endpoint } from "../platform/endpoint.js";
import { RestartBudget } from "./restart-budget.js";
export { RestartBudget } from "./restart-budget.js";
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    // Access-denied and unknown errors cannot authorize replacement of a process.
    return true;
  }
}

/** Owns restart admission only; the worker remains the sole database and task owner. */
export async function superviseWorker(
  directory: string,
  workerPath: string,
  ready: () => void,
  signal: AbortSignal,
) {
  await mkdir(directory, { recursive: true });
  const ownership = await ownDirectory(directory, "supervisor");
  const id = randomUUID();
  const budget = new RestartBudget();
  let endpoint: Endpoint | undefined;
  let restarts = 0;
  let previousState = "";
  let publishedAt = 0;
  const status = async (
    state:
      | "starting"
      | "running"
      | "unhealthy"
      | "restarting"
      | "stopped"
      | "failed",
    detail: string,
  ) => {
    const key = `${state}:${endpoint?.pid ?? 0}:${restarts}`;
    if (key === previousState && Date.now() - publishedAt < 10000) return;
    await publishEndpoint(
      directory,
      {
        version: 1,
        id,
        pid: process.pid,
        workerPid: endpoint?.pid ?? null,
        state,
        restarts,
        detail,
        updatedAt: Date.now(),
      },
      "supervisor.json",
    );
    previousState = key;
    publishedAt = Date.now();
  };
  try {
    signal.throwIfAborted();
    await status("starting", "正在启动后台。");
    endpoint = await connectWorker(directory, workerPath, id);
    if (endpoint.supervisionId !== id)
      throw new AppError(
        "conflict",
        "现有后台不属于本次守护，请正常停止旧后台后重新启动。",
      );
    await status("running", "后台正常，界面退出后仍监测意外退出。");
    ready();
    for (;;) {
      if (await stopWasRequested(directory, id)) break;
      await delay(2000, undefined, { signal });
      if (await stopWasRequested(directory, id)) break;
      try {
        const current = await readWorker(directory, signal);
        if (current.supervisionId !== id || current.pid !== endpoint.pid)
          throw new AppError("conflict", "后台身份改变，守护未接管其他进程。");
        await status("running", "后台健康检查通过。");
      } catch (error) {
        signal.throwIfAborted();
        if (await stopWasRequested(directory, id)) break;
        if (error instanceof AppError && error.code === "conflict") throw error;
        if (alive(endpoint.pid)) {
          await status(
            "unhealthy",
            "后台健康检查失败但进程仍存活；未另起竞争后台或重发任务。",
          );
          continue;
        }
        const wait = budget.nextDelay(performance.now());
        if (wait === null)
          throw new AppError(
            "unavailable",
            "五分钟内后台已恢复五次，停止自动重启；请查看诊断后重新启动应用。",
          );
        restarts++;
        await status(
          "restarting",
          "后台意外退出，等待有界退避后恢复；未重发未知任务。",
        );
        await delay(wait, undefined, { signal });
        if (await stopWasRequested(directory, id)) break;
        endpoint = await connectWorker(directory, workerPath, id);
        if (endpoint.supervisionId !== id)
          throw new AppError("conflict", "恢复时出现其他后台，守护停止接管。");
        if (!(await stopWasRequested(directory, id)))
          await status("running", "后台已恢复；中断运行保留为结果未知。");
      }
    }
    const stopDeadline = performance.now() + 30000;
    while (alive(endpoint.pid)) {
      if (performance.now() >= stopDeadline)
        throw new AppError(
          "unknown",
          "已禁止自动重启，但后台未在三十秒内退出；请核实诊断，未强杀进程。",
        );
      await delay(250, undefined, { signal });
    }
    await status("stopped", "用户停止请求已完成，不再自动启动后台。");
  } catch (error) {
    if (signal.aborted && endpoint?.supervisionId === id) {
      await callWorker(endpoint, workerRoutes.command, {
        id: randomUUID(),
        command: { type: "worker.stop" },
      }).catch((failure: unknown) => {
        console.error(
          "supervisor could not confirm worker shutdown",
          failure instanceof AppError ? failure.code : "transport",
        );
      });
    }
    await status(
      "failed",
      error instanceof AppError
        ? error.message
        : signal.aborted
          ? "守护已停止。"
          : "后台守护遇到故障，请检查诊断。",
    );
    throw error;
  } finally {
    // Only this generation's marker is removed; no other process's intent is changed.
    try {
      await rm(stopMarker(directory, id), { force: true });
    } finally {
      await ownership.close();
    }
  }
}
