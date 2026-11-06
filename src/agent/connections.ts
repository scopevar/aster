import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../shared/core.js";
import {
  agentConnectionsRequestSchema,
  type AgentConnectionsRequest,
  type AgentConnectionsStatus,
} from "../shared/agent-connections.js";
import {
  configRevision,
  modelConfigPath,
  readAgentConfig,
} from "./config-file.js";
import { PiAgent } from "./pi.js";
import { PiCredentials } from "./pi-credentials.js";
import { JevConnection } from "./jev.js";
import { jevConfigSchema } from "../shared/chat/group-host.js";
import { HostJudge } from "../chat/group-judge.js";
import type { StructuredModel } from "../shared/memory.js";

/** Device-local non-secret settings. No global agent configuration is read or rewritten. */
export class AgentConnections {
  private busy = false;
  private readonly path: string;
  private readonly credentials: PiCredentials;
  private readonly jev: JevConnection;
  constructor(
    private readonly workspace: string,
    private readonly changed: () => void = () => {},
  ) {
    this.path = modelConfigPath(workspace);
    this.credentials = new PiCredentials(workspace);
    this.jev = new JevConnection(workspace);
  }
  async groupJudge(host: StructuredModel) {
    const config = jevConfigSchema.parse(
      readAgentConfig(this.path).config.jev ?? {},
    );
    return new HostJudge(
      host,
      config.enabled ? await this.jev.client(config) : undefined,
    );
  }
  async scriptReviewer() {
    const config = jevConfigSchema.parse(
      readAgentConfig(this.path).config.jev ?? {},
    );
    return config.enabled ? this.jev.client(config) : undefined;
  }
  status(notice = ""): AgentConnectionsStatus {
    const file = readAgentConfig(this.path);
    const entry = file.config.connections.find(
      (item) => item.id === file.config.defaultAgent,
    );
    return {
      revision: configRevision(file.text),
      config: file.config,
      path: this.path,
      override: null,
      active: entry
        ? `Pi · ${entry.provider} / ${entry.model}`
        : "尚未添加供应商",
      notice,
    };
  }
  private async response(notice = ""): Promise<AgentConnectionsStatus> {
    const status = this.status(notice);
    try {
      return {
        ...status,
        storedProviders: (await this.credentials.list()).map(
          (entry) => entry.providerId,
        ),
        jevHasKey: await this.jev.hasKey(),
      };
    } catch {
      throw new AppError(
        "unavailable",
        "应用凭证库无法读取，请检查本机安全存储后重试。",
      );
    }
  }
  async request(
    value: AgentConnectionsRequest,
    signal: AbortSignal,
  ): Promise<AgentConnectionsStatus> {
    const request = agentConnectionsRequestSchema.parse(value);
    signal.throwIfAborted();
    if (request.action === "status") return this.response();
    if (this.busy) throw new AppError("conflict", "模型配置操作正在进行。");
    this.busy = true;
    try {
      if (request.action === "jev.test") {
        await this.jev.test(request.config, request.apiKey, signal);
        return await this.response("Jev 连接与判断测试通过。");
      }
      if (request.action === "check" || request.action === "test") {
        const agent = new PiAgent(
          this.workspace,
          request.connection,
          request.apiKey,
        );
        const result =
          request.action === "check"
            ? await agent.check(signal)
            : await agent.test(
                AbortSignal.any([signal, AbortSignal.timeout(60000)]),
              );
        return await this.response(result.detail);
      }
      if (request.action !== "save" && request.action !== "assign")
        throw new AppError("invalid_input", "无效配置操作。");
      const current = readAgentConfig(this.path);
      if (
        request.action === "assign" &&
        !current.config.connections.some(
          (entry) => entry.id === request.connectionId && entry.enabled,
        )
      )
        throw new AppError(
          "invalid_input",
          "供应商已停用或不存在，请重新选择。",
        );
      const revision =
        request.action === "save"
          ? request.revision
          : configRevision(current.text);
      const config =
        request.action === "save"
          ? request.config
          : {
              ...current.config,
              botConnections: {
                ...current.config.botConnections,
                [request.botId]: request.connectionId,
              },
            };
      if (revision !== configRevision(current.text))
        throw new AppError("conflict", "配置已修改，请重新读取后保存。");
      if (
        config.jev?.enabled &&
        !(request.action === "save" && request.jevApiKey) &&
        !(await this.jev.hasKey())
      )
        throw new AppError("invalid_input", "启用 Jev 前请填写 API Key。");
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      try {
        const file = await open(temp, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
        if (configRevision(readAgentConfig(this.path).text) !== revision)
          throw new AppError("conflict", "配置已修改，未覆盖文件。");
        await rename(temp, this.path);
        this.changed();
        if (request.action === "save" && request.jevApiKey) {
          try {
            await this.jev.saveKey(request.jevApiKey);
          } catch {
            throw new AppError(
              "unknown",
              "Jev 配置已保存，但密钥保存结果未确认，请重新读取设置后核实。",
            );
          }
        }
        if (request.action === "save" && request.credential) {
          try {
            const { provider, key } = request.credential;
            await this.credentials.modify(provider, async () => ({
              type: "api_key",
              key,
            }));
          } catch {
            throw new AppError(
              "unknown",
              "连接配置已保存，但 API Key 未能确认保存。请返回列表，重新打开此连接并填写密钥后保存。",
            );
          }
        }
        return await this.response(
          "已保存；下一次运行使用新配置，当前任务保留启动配置。",
        );
      } finally {
        await unlink(temp).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
