import { join } from "node:path";
import type { Job, Store } from "../storage/store.js";
import { AppError } from "../shared/core.js";
import { ScriptSession } from "./session.js";
import type { AgentConnections } from "../agent/connections.js";
import { ScriptApprovals } from "./approvals.js";
import { SandboxResources } from "./resources.js";
import { SandboxSettingsStore } from "./settings-store.js";
import { SandboxNetworkDiagnostics } from "./network-test.js";
import type {
  SandboxSettingsRequest,
  SandboxSettingsStatus,
} from "../shared/tools/sandbox-settings.js";

export class SandboxService {
  private readonly sessions = new Set<ScriptSession>();
  private readonly owners = new Map<string, ScriptSession>();
  private stopped = false;
  private readonly resources: SandboxResources;
  private readonly settings: SandboxSettingsStore;
  private readonly diagnostics: SandboxNetworkDiagnostics;
  private readonly approvals: ScriptApprovals | undefined;
  constructor(
    private readonly store: Pick<
      Store,
      "files" | "runs" | "subscribe" | "toolOperations"
    >,
    private readonly directory: string,
    connections?: AgentConnections,
  ) {
    this.approvals = connections
      ? new ScriptApprovals(store, connections)
      : undefined;
    this.resources = new SandboxResources(join(directory, "scripts"));
    this.settings = new SandboxSettingsStore(
      join(directory, "scripts", "network.json"),
    );
    this.diagnostics = new SandboxNetworkDiagnostics(
      join(directory, "scripts"),
      this.resources,
    );
  }
  start() {
    this.resources.start();
  }
  async request(
    request: SandboxSettingsRequest,
    signal: AbortSignal,
    enabled: boolean,
  ): Promise<SandboxSettingsStatus> {
    signal.throwIfAborted();
    if (this.stopped) throw new AppError("unavailable", "沙箱服务正在停止。");
    if (!enabled && request.action !== "status")
      throw new AppError(
        "forbidden",
        "此设备仅为控制端，请在执行机器上配置沙箱。",
      );
    let notice = "";
    if (request.action === "save") {
      await this.settings.save(request.revision, request.configuration, signal);
      notice = "已保存，下一次启动沙箱时生效；正在执行的任务继续使用原配置。";
    } else if (request.action === "prepare") {
      this.resources.start();
    } else if (request.action === "test") {
      if (this.sessions.size >= 2)
        throw new AppError(
          "capacity",
          "沙箱通道已满，请等待任务结束后检查连接。",
        );
      this.diagnostics.start(
        request.id,
        request.hostname,
        request.configuration,
      );
    } else if (request.action === "cancel") {
      await this.diagnostics.cancel(request.id);
    }
    return {
      enabled,
      ...(await this.settings.read()),
      resources: this.resources.view(),
      test: this.diagnostics.state,
      notice,
    };
  }
  open(job: Job, signal: AbortSignal) {
    if (this.stopped) throw new AppError("unavailable", "脚本服务正在停止。");
    if (this.sessions.size + (this.diagnostics.running ? 1 : 0) >= 2)
      throw new AppError(
        "capacity",
        "Bot 脚本工作区已占用或两个虚拟机通道已满。",
      );
    const session = new ScriptSession(
      this.store,
      job,
      join(this.directory, "scripts"),
      join(this.directory, "workspaces"),
      signal,
      this.resources,
      this.settings,
      this.approvals,
      () => {
        const owner = this.owners.get(job.botId);
        if (owner && owner !== session)
          throw new AppError(
            "capacity",
            "这个 Bot 的脚本工作区正在被另一轮使用。",
          );
        this.owners.set(job.botId, session);
      },
    );
    this.sessions.add(session);
    return {
      request: session.request.bind(session),
      read: session.read.bind(session),
      stage: session.stage.bind(session),
      cancel: session.cancel.bind(session),
      close: async () => {
        await session.close();
        this.sessions.delete(session);
        if (this.owners.get(job.botId) === session)
          this.owners.delete(job.botId);
      },
    };
  }
  async stop() {
    this.stopped = true;
    const results = await Promise.allSettled([
      this.resources.stop(),
      this.diagnostics.stop(),
      ...[...this.sessions.values()].map((session) => session.close()),
    ]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    this.sessions.clear();
    this.owners.clear();
  }
}
