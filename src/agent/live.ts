import type { Agent, AgentInput } from "../chat/agent.js";
import type { StructuredModel } from "../shared/memory.js";
import { PiAgent } from "./pi.js";
import { modelConfigPath, readAgentConfig } from "./config-file.js";
import { cleanPiSessions, isPiSession } from "./pi-sessions.js";
import { AppError } from "../shared/core.js";

/** Each run captures configuration; sessions are independent of provider selection. */
export class LiveAgent implements Agent, StructuredModel {
  constructor(private readonly workspace: string) {}
  get retainCancelledContext() {
    return (
      readAgentConfig(modelConfigPath(this.workspace)).config
        .retainCancelledContext ?? true
    );
  }
  private configured(botId?: string) {
    const { config } = readAgentConfig(modelConfigPath(this.workspace));
    const connection = botId
      ? config.connections.find(
          (entry) => entry.id === config.botConnections?.[botId],
        )
      : (config.connections.find(
          (entry) => entry.id === config.defaultAgent && entry.enabled,
        ) ?? config.connections.find((entry) => entry.enabled));
    if (botId && !connection)
      throw new AppError("unavailable", "请在 Bot 设置中选择可用的供应商。");
    if (connection && !connection.enabled)
      throw new AppError(
        "unavailable",
        "此 Bot 的供应商已停用，请在 Bot 设置中重新选择或启用供应商。",
      );
    if (!connection)
      throw new AppError(
        "unavailable",
        "尚未配置模型，请在设置 → 模型与连接中添加供应商。",
      );
    return new PiAgent(
      this.workspace,
      connection,
      undefined,
      config.retainCancelledContext ?? true,
    );
  }
  capture(botId?: string) {
    return this.configured(botId);
  }
  requiresFreshSession(threadId: string | null) {
    return Boolean(threadId && !isPiSession(threadId));
  }
  check(signal?: AbortSignal) {
    return this.configured().check(signal);
  }
  run(input: AgentInput) {
    return this.configured(input.sessionScope?.botId).run(input);
  }
  generate(input: Parameters<StructuredModel["generate"]>[0]) {
    return this.configured().generate(input);
  }
  cleanThreads = cleanPiSessions;
}
