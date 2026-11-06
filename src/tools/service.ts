import { randomBytes } from "node:crypto";
import { PluginSession } from "../plugins/session.js";
import type { SandboxService } from "../sandbox/service.js";
import { ReadSession } from "./read-session.js";
import { artifactRequestSchema } from "../shared/files/reads.js";
import { scriptRequestSchema } from "../shared/tools/scripts.js";
import type { PluginOAuth } from "../plugins/oauth.js";
import type { DocumentReader } from "../documents/reader.js";
import { DocumentSession } from "../documents/service.js";
import { FileSession } from "../files/session.js";
import { AppError } from "../shared/core.js";
import { questionRequestSchema } from "../shared/chat/questions.js";
import type { Job, Store } from "../storage/store.js";
type Scope = {
  reads: ReadSession;
  scripts: ReturnType<SandboxService["open"]> | undefined;
  plugins: PluginSession;
  files: FileSession;
  documents: DocumentSession | undefined;
  job: Job;
  token: string;
  closed: boolean;
  skillAttempts: number;
  routineAttempts: number;
  notifyAttempts: number;
  templateAttempts: number;
  historyAttempts: number;
  close(): Promise<void>;
};

/** Runtime owns scopes. SQLite owns decisions. Transport cancellation is supplemental to the runtime signal. */
export class ToolService {
  private scopes = new Map<string, Scope>();
  constructor(
    private readonly store: Pick<
      Store,
      | "documentOperations"
      | "files"
      | "pluginCalls"
      | "plugins"
      | "routineOperations"
      | "runs"
      | "subscribe"
      | "toolOperations"
      | "views"
    >,
    private readonly port: number,
    private readonly pdf?: DocumentReader,
    private readonly oauth?: PluginOAuth,
    private readonly sandbox?: SandboxService,
  ) {}
  open(job: Job, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.scopes.size >= 2)
      throw new AppError("capacity", "工具运行通道已满。");
    const token = randomBytes(32).toString("hex");
    const cancel = () => {
      scope.closed = true;
      this.scopes.delete(token);
      scope.documents?.cancel();
      scope.reads.cancel();
      scope.files.cancel();
      scope.plugins.cancel();
      scope.scripts?.cancel();
    };
    const scripts = this.sandbox?.open(job, signal);
    const scope: Scope = {
      reads: new ReadSession(this.store, job, scripts),
      scripts,
      plugins: new PluginSession(this.store, job, signal, this.oauth),
      files: new FileSession(this.store, job, undefined, this.pdf),
      job,
      documents: this.pdf
        ? new DocumentSession(this.store, this.pdf, job)
        : undefined,
      token,
      closed: false,
      skillAttempts: 0,
      routineAttempts: 0,
      notifyAttempts: 0,
      templateAttempts: 0,
      historyAttempts: 0,
      close: async () => {
        cancel();
        signal.removeEventListener("abort", cancel);
        const closed = await Promise.allSettled([
          scope.documents?.close(),
          scope.reads.close(),
          scope.files.close(),
          scope.plugins.close(),
          scope.scripts?.close(),
        ]);
        for (const result of closed)
          if (result.status === "rejected") throw result.reason;
      },
    };
    this.scopes.set(token, scope);
    signal.addEventListener("abort", cancel, { once: true });
    return { connection: { port: this.port, token }, close: scope.close };
  }
  plugins(token: string, value: unknown, signal: AbortSignal) {
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    return scope.plugins.request(value, signal);
  }
  scripts(token: string, value: unknown, signal: AbortSignal) {
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    const request = scriptRequestSchema.parse(value);
    if (!scope.scripts) throw new AppError("unavailable", "脚本服务未装配。");
    return scope.scripts.request(request, signal);
  }
  read(token: string, value: unknown, signal: AbortSignal) {
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    return scope.reads.request(value, signal);
  }
  async artifacts(token: string, value: unknown, signal: AbortSignal) {
    const scope = this.scopes.get(token);
    if (!scope || scope.closed || !scope.scripts)
      throw new AppError("unauthorized", "文件交付授权已结束。");
    const request = artifactRequestSchema.parse(value);
    const attachments = [];
    for (const [index, path] of request.paths.entries()) {
      if (!path.startsWith("/workspace/"))
        throw new AppError("unauthorized", "只能交付当前 Bot 的工作文件。");
      const result = await scope.scripts.request(
        {
          callId: `attachment:${request.messageId}:${index}`,
          operation: {
            action: "export",
            path: path.slice("/workspace/".length),
            name: path.split("/").at(-1),
          },
        },
        signal,
      );
      if (result.action !== "export")
        throw new AppError("internal", "文件交付响应不匹配。");
      attachments.push(result.attachment);
    }
    return { attachments };
  }
  question(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    const request = questionRequestSchema.parse(value);
    const question = this.store.toolOperations.questionRequest(
      scope.job,
      request.callId,
      request.question,
    );
    return { id: question.id, status: question.status };
  }
  documents(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (!scope.documents) throw new AppError("unavailable", "文档服务未装配。");
    return scope.documents.request(value, signal);
  }
  history(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (++scope.historyAttempts > 128)
      throw new AppError(
        "capacity",
        "本回合历史读取超过 128 次，请在下一回合继续。",
      );
    return this.store.runs.historyRequest(scope.job, value);
  }
  files(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    return scope.files.request(value, signal);
  }
  skills(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (++scope.skillAttempts > 64)
      throw new AppError(
        "capacity",
        "本回合技能请求超过 64 次，已停止接受新请求。",
      );
    return this.store.toolOperations.skillToolRequest(scope.job, value);
  }
  routines(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (++scope.routineAttempts > 64)
      throw new AppError("capacity", "本回合任务请求超过 64 次。");
    return this.store.toolOperations.routineToolRequest(scope.job, value);
  }
  notify(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (++scope.notifyAttempts > 8)
      throw new AppError("capacity", "本次运行最多发送 8 条通知。");
    return this.store.toolOperations.notificationRequest(scope.job, value);
  }
  templates(token: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = this.scopes.get(token);
    if (!scope || scope.closed)
      throw new AppError("unauthorized", "工具运行授权已结束。");
    if (++scope.templateAttempts > 64)
      throw new AppError("capacity", "本回合模板请求超过 64 次。");
    return this.store.toolOperations.templateToolRequest(scope.job, value);
  }
  wake() {
    for (const scope of this.scopes.values()) {
      scope.reads.refreshGrants();
      scope.files.refreshGrants();
    }
  }
}
