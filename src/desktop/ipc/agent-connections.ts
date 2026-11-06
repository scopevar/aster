import { workerRoutes } from "../../shared/protocol.js";
import { z } from "zod";
import {
  agentConnectionsStatusSchema,
  type AgentConnectionsRequest,
  type AgentConnectionsStatus,
} from "../../shared/agent-connections.js";
import { AppError } from "../../shared/core.js";
import type { WorkerConnection } from "../worker/worker-connection.js";

const legacyStatusSchema = agentConnectionsStatusSchema.extend({
  restartRequired: z.boolean(),
});

function readStatus(
  value: unknown,
  action: AgentConnectionsRequest["action"],
): AgentConnectionsStatus {
  const parsed = agentConnectionsStatusSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (legacyStatusSchema.safeParse(value).success)
    throw new AppError(
      action === "status" ? "conflict" : "unknown",
      action === "status"
        ? "后台仍为不支持连接热重载的旧版。请在设置 → 通用中停止本机后台，再重新启动应用以加载新版；此后修改连接无需重启。"
        : "后台版本发生变化，操作结果未确认。请在设置 → 通用中停止本机后台，再重新启动应用以加载新版。",
    );
  throw new AppError(
    action === "status" ? "unavailable" : "unknown",
    action === "status"
      ? "后台返回的连接配置无效，请检查后台版本。"
      : "后台返回的连接响应无效，操作结果未确认。请重新读取配置后核实。",
  );
}

/** Detect an old resident worker before allowing it to save or test a connection. */
export async function requestAgentConnections(
  worker: Pick<WorkerConnection, "call">,
  request: AgentConnectionsRequest,
): Promise<AgentConnectionsStatus> {
  const path = workerRoutes.agentConnections;
  if (request.action !== "status")
    readStatus(await worker.call(path, { action: "status" }), "status");
  return readStatus(await worker.call(path, request), request.action);
}
