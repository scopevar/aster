import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  ownDirectory,
  DirectoryLeaseBusy,
} from "../platform/directory-lease.js";
import { readWorker, callWorker } from "../worker/client.js";
import { workerRoutes } from "../shared/protocol.js";
import { AppError, resultSchema } from "../shared/core.js";
import type { Endpoint } from "../platform/endpoint.js";
import { randomUUID } from "node:crypto";
import { launchWindowsDaemon } from "./windows-launch.js";

export async function daemonStatus(directory: string) {
  try {
    return await readWorker(directory);
  } catch {
    try {
      const lease = await ownDirectory(directory, "worker");
      await lease.close();
      return null;
    } catch (leaseError) {
      if (
        leaseError instanceof Error &&
        "code" in leaseError &&
        leaseError.code === "ENOENT"
      )
        return null;
      if (!(leaseError instanceof DirectoryLeaseBusy)) throw leaseError;
    }
    throw new AppError(
      "unavailable",
      "daemon 身份或健康状态无法确认；未启动竞争实例。",
    );
  }
}

/** Start admission is serialized separately from the lifetime database lease. */
export async function ensureDaemon(
  directory: string,
  launch: {
    executable: string;
    script: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<Endpoint> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    ASTER_DATA_DIR: directory,
  };
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + 20000;
  let lease: Awaited<ReturnType<typeof ownDirectory>> | undefined;
  while (!lease) {
    try {
      lease = await ownDirectory(directory, "daemon-start");
    } catch (error) {
      if (!(error instanceof DirectoryLeaseBusy)) throw error;
      if (Date.now() >= deadline)
        throw new AppError(
          "unavailable",
          "另一启动尚未确认，请检查 daemon 状态。",
        );
      await delay(100);
    }
  }
  try {
    const existing = await daemonStatus(directory);
    if (existing) {
      if (existing.kind !== "daemon")
        throw new AppError("conflict", "数据目录由旧 Worker 占用，未接管。");
      if (existing.role === "controller")
        throw new AppError(
          "conflict",
          "此目录正在以仅远端角色运行，请明确停止该控制服务再启用本机执行。",
        );
      return existing;
    }
    const log = await open(join(directory, "daemon.log"), "a", 0o600);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ASTER_SUPERVISION_ID;
    let failure: string | undefined;
    try {
      if (process.platform === "win32")
        await launchWindowsDaemon(launch.executable, launch.script, env);
      else {
        const child = spawn(launch.executable, [launch.script, "run"], {
          env,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
        child.once("error", () => {
          failure = "daemon 运行时无法启动，请检查安装。";
        });
        child.once("exit", () => {
          failure = "daemon 在启动时退出，请检查 daemon.log。";
        });
        child.unref();
      }
      while (Date.now() < deadline) {
        // A new owner acquires the lease before replacing the previous endpoint.
        // During our admitted startup this gap is expected; wait without spawning again.
        const endpoint = await readWorker(directory).catch(() => null);
        if (endpoint?.kind === "daemon") return endpoint;
        if (failure) throw new AppError("unavailable", failure);
        await delay(100);
      }
      throw new AppError(
        "unknown",
        "daemon 启动未确认；没有自动终止或重复启动，请检查状态和日志。",
      );
    } finally {
      await log.close();
    }
  } finally {
    await lease.close();
  }
}

/** Only authenticated admission plus a generation-specific cleanup receipt proves shutdown. */
export async function stopDaemon(directory: string, timeoutMs = 30000) {
  const endpoint = await daemonStatus(directory);
  if (!endpoint)
    throw new AppError("unavailable", "daemon 不在线，无法确认正常清理结果。");
  if (endpoint.kind !== "daemon" || !endpoint.instanceId)
    throw new AppError("conflict", "当前是旧 Worker，请使用其原有停止入口。");
  resultSchema.parse(
    await callWorker(
      endpoint,
      workerRoutes.command,
      {
        id: randomUUID(),
        command: { type: "worker.stop" },
      },
      undefined,
      Math.min(5000, timeoutMs),
    ),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = z
        .object({ instanceId: z.uuid(), cleaned: z.literal(true) })
        .strict()
        .parse(
          JSON.parse(
            await readFile(join(directory, "daemon-stopped.json"), "utf8"),
          ),
        );
      if (receipt.instanceId === endpoint.instanceId) {
        const lease = await ownDirectory(directory, "worker");
        await lease.close();
        try {
          process.kill(endpoint.pid, 0);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return;
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code !== "ENOENT" &&
        error.code !== "EADDRINUSE"
      )
        throw error;
    }
    await delay(100);
  }
  throw new AppError(
    "unknown",
    "daemon 未在期限内确认清理；未强杀进程，运行结果须核实。",
  );
}
