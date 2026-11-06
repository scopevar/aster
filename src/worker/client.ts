import { workerRoutes } from "../shared/protocol.js";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { endpointSchema, type Endpoint } from "../platform/endpoint.js";
import { workerStartupSchema } from "./startup.js";
import { stopWasRequested } from "./supervision.js";
import { AppError, failureSchema } from "../shared/core.js";

const healthSchema = z
  .object({
    pid: z.number().int().positive(),
  })
  .strict();

export async function readWorker(
  directory: string,
  signal?: AbortSignal,
  timeoutMs = 1000,
): Promise<Endpoint> {
  const healthSignal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const raw: unknown = JSON.parse(
    await readFile(join(directory, "endpoint.json"), {
      encoding: "utf8",
      signal: healthSignal,
    }),
  );
  const endpoint = endpointSchema.parse(raw);
  const health = healthSchema.parse(
    await callWorker(endpoint, workerRoutes.health, undefined, healthSignal),
  );
  if (health.pid !== endpoint.pid)
    throw new AppError("unavailable", "后台连接记录与实际进程不匹配。");
  return endpoint;
}

export async function callWorker(
  endpoint: Endpoint,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 35000,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]),
    redirect: "error",
  });
  const value: unknown = await response.json();
  if (!response.ok) throw failureOf(value);
  return value;
}

function failureOf(value: unknown) {
  const failure = failureSchema.safeParse(
    value && typeof value === "object" && "error" in value ? value.error : null,
  );
  return failure.success
    ? new AppError(failure.data.code, failure.data.message)
    : new AppError("unavailable", "后台响应无效。");
}

/** 打开长连接 GET（SSE）。没有总超时：存活由调用方的心跳看门狗与 signal 决定。 */
export async function openWorkerStream(
  endpoint: Endpoint,
  path: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      Accept: "text/event-stream",
    },
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    const text = await response.text();
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    throw failureOf(value);
  }
  if (!response.body) throw new AppError("unavailable", "后台事件流为空。");
  return response.body;
}
export async function connectWorker(
  directory: string,
  workerPath: string,
  supervisionId?: string,
  executable = process.execPath,
): Promise<Endpoint> {
  const deadline = Date.now() + 15000;
  const startupSignal = AbortSignal.timeout(15000);
  async function read(): Promise<Endpoint | undefined> {
    try {
      return await readWorker(directory, startupSignal);
    } catch (error) {
      if (error instanceof AppError && error.code === "conflict") throw error;
      if (error instanceof Error && "code" in error && error.code === "EACCES")
        throw error;
      return undefined;
    }
  }
  const existing = await read();
  if (existing) return existing;
  await mkdir(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASTER_DATA_DIR: directory,
    ...(supervisionId
      ? { ASTER_SUPERVISION_ID: z.uuid().parse(supervisionId) }
      : {}),
  };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  const child = spawn(executable, [workerPath], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env,
  });
  let failure: string | undefined;
  let state: "starting" | "ready" | "contended" | "failed" = "starting";
  const onMessage = (value: unknown) => {
    const status = workerStartupSchema.safeParse(value);
    if (!status.success) {
      failure = "后台启动响应无效。";
      return;
    }
    state = status.data.state;
    if (state === "failed") failure = status.data.message;
  };
  const onError = (error: Error) => {
    failure = error.message;
  };
  const onExit = (code: number | null) => {
    if (state === "starting" || state === "ready")
      failure = `后台在启动期间退出（代码 ${code ?? "未知"}）。`;
  };
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("exit", onExit);
  const handshakeReady = () => state === "ready" || state === "contended";
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      child.once("error", failed);
      child.once("spawn", () => {
        child.removeListener("error", failed);
        child.unref();
        resolve();
      });
    });
    while (Date.now() < deadline) {
      const endpoint = await read();
      // A supervisor publishes the worker endpoint before its own readiness is confirmed.
      // Returning on the file alone can expose a child whose recovery owner is not ready yet.
      if (endpoint && handshakeReady()) return endpoint;
      // A user may stop the newly reachable worker before its startup IPC is read.
      // Only the child we just spawned and this exact supervision generation can
      // complete this interrupted startup; never adopt a disk PID or start again.
      if (supervisionId && (await stopWasRequested(directory, supervisionId))) {
        const stopping = endpointSchema.parse(
          JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")),
        );
        if (
          stopping.supervisionId === supervisionId &&
          stopping.pid === child.pid
        )
          return stopping;
        throw new AppError("conflict", "停止中的后台与本次启动身份不一致。");
      }
      if (failure) throw new AppError("unavailable", failure);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new AppError(
      "unavailable",
      "后台启动未在十五秒内确认。请核实已有进程状态；没有自动重复启动。",
    );
  } finally {
    child.removeListener("message", onMessage);
    child.removeListener("exit", onExit);
    child.removeListener("error", onError);
    if (child.connected) child.disconnect();
  }
}
