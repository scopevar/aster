import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  DirectoryLeaseBusy,
  ownDirectory,
} from "../../platform/directory-lease.js";
import { endpointSchema } from "../../platform/endpoint.js";
import { workerRoutes } from "../../shared/protocol.js";
import { callWorker } from "../../worker/client.js";

const recordedEndpoint = endpointSchema.extend({
  // Only installed old workers still write this metadata; new endpoints omit it.
  version: z.number().int().positive().optional(),
  pid: z.number().int().positive(),
});
type RecordedEndpoint = z.infer<typeof recordedEndpoint>;
const healthSchema = z
  .object({
    version: z.number().int().positive().optional(),
    pid: z.number().int().positive(),
  })
  .strict();
export type WorkerInspection =
  | { state: "absent" | "stale" }
  | { state: "running"; endpoint: RecordedEndpoint }
  | { state: "unverified"; message: string };

function refused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error && error.code === "ECONNREFUSED") || refused(error.cause)
  );
}
/** Only the shutdown path understands the installed old worker's route prefix. */
function recordedPath(
  endpoint: RecordedEndpoint,
  path: typeof workerRoutes.health | typeof workerRoutes.command,
) {
  return endpoint.version === undefined ? path : `/v${endpoint.version}${path}`;
}
/** Confirm the live PID and, for old records, their metadata before sending a stop. */
export async function inspectWorker(
  directory: string,
  timeoutMs = 2000,
): Promise<WorkerInspection> {
  let text: string;
  try {
    text = await readFile(join(directory, "endpoint.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { state: "absent" };
    return { state: "unverified", message: "后台连接记录无法读取。" };
  }
  try {
    if (text.length > 8192) throw new Error("后台连接记录过大。");
    const endpoint = recordedEndpoint.parse(JSON.parse(text) as unknown);
    let raw: unknown;
    try {
      raw = await callWorker(
        endpoint,
        recordedPath(endpoint, workerRoutes.health),
        undefined,
        undefined,
        timeoutMs,
      );
    } catch (error) {
      if (refused(error)) return { state: "stale" };
      throw error;
    }
    const health = healthSchema.parse(raw);
    if (
      health.pid !== endpoint.pid ||
      (endpoint.version !== undefined && health.version !== endpoint.version)
    )
      throw new Error("后台连接记录与实际进程身份不匹配。");
    return {
      state: "running",
      endpoint,
    };
  } catch (error) {
    return {
      state: "unverified",
      message:
        error instanceof z.ZodError
          ? "后台连接记录或健康响应无效。"
          : error instanceof Error
            ? error.name === "TimeoutError"
              ? "后台健康检查超时，可能正在处理同步任务；身份尚未确认。"
              : error.message
            : "后台身份无法确认。",
    };
  }
}
async function waitForOwnership(directory: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const leases: Awaited<ReturnType<typeof ownDirectory>>[] = [];
    try {
      leases.push(await ownDirectory(directory, "worker"));
      leases.push(await ownDirectory(directory, "supervisor"));
      return;
    } catch (error) {
      if (!(error instanceof DirectoryLeaseBusy)) throw error;
    } finally {
      await Promise.all(leases.map((lease) => lease.close()));
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    "后台尚未释放数据目录。请稍后执行 pnpm dev --doctor；未强杀或重复发送停止请求。",
  );
}
/** Every dev startup uses the authenticated stop API and waits for both owners. */
export async function stopWorker(directory: string, timeoutMs = 30000) {
  const inspection = await inspectWorker(directory, Math.min(timeoutMs, 20000));
  if (inspection.state === "unverified")
    throw new Error(
      `${inspection.message} 请等待任务结束后重试 pnpm dev；持续失败时按 README 的“后台连接记录恢复”检查 PID、端口和目录持有者。未向身份不匹配的服务发送停止请求。`,
    );
  if (inspection.state === "absent") {
    try {
      await stat(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
  }
  if (inspection.state === "running") {
    const { endpoint } = inspection;
    console.info("正在正常停止旧后台；进行中的任务将取消。");
    const result = await callWorker(
      endpoint,
      recordedPath(endpoint, workerRoutes.command),
      {
        ...(endpoint.version === undefined
          ? {}
          : { version: endpoint.version }),
        id: randomUUID(),
        command: { type: "worker.stop" },
      },
      undefined,
      5000,
    );
    if (!result || typeof result !== "object" || "error" in result)
      throw new Error(
        "后台未确认停止请求。请执行 pnpm dev --doctor 核实状态；未重试或强杀。",
      );
  }
  await waitForOwnership(directory, timeoutMs);
}
