import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readGrantedBytes, readGrantedPath } from "../files/read.js";
import type { Job, Store } from "../storage/store.js";
import { AppError } from "../shared/core.js";
import { type ToolExecution } from "../shared/chat/messages.js";
import {
  scriptRequestSchema,
  type ScriptAction,
  type ScriptExecution,
  type ScriptResult,
} from "../shared/tools/scripts.js";
import type { SandboxResources } from "./resources.js";
import type { SandboxSettingsStore } from "./settings-store.js";
import { SandboxProcess } from "./process.js";
import type { ScriptApprovals } from "./approvals.js";
import {
  clearScriptInputs,
  listScriptFiles,
  prepareWorkspace,
  readScriptFile,
  scriptInputPath,
  scriptWorkspaceQuota,
} from "./workspace.js";

/** One Agent round owns one VM and one exclusive Bot workspace lane. */
export class ScriptSession {
  private readonly controller = new AbortController();
  private readonly scopeId = randomUUID();
  private readonly calls = new Map<
    string,
    { fingerprint: string; result: Promise<ScriptResult> }
  >();
  private process: SandboxProcess | undefined;
  private ready = false;
  private preparation: ReturnType<typeof prepareWorkspace> | undefined;
  private network: string[] | undefined;
  private busy = false;
  private stagedBytes = 0;
  private readonly staged = new Map<string, Promise<string>>();
  private readonly fileTasks = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private readonly workspace: string;
  private readonly abort: () => void;
  constructor(
    private readonly store: Pick<
      Store,
      "files" | "runs" | "subscribe" | "toolOperations"
    >,
    private readonly job: Job,
    private readonly root: string,
    private readonly workspaces: string,
    private readonly signal: AbortSignal,
    private readonly resources: SandboxResources,
    private readonly settings: SandboxSettingsStore,
    private readonly approvals: ScriptApprovals | undefined,
    private readonly acquire: () => void,
  ) {
    this.workspace = join(workspaces, job.botId, "script-work");
    this.abort = () => this.cancel();
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.cancel();
  }
  cancel() {
    this.controller.abort();
  }
  private async paths(signal: AbortSignal) {
    this.authorize();
    this.acquire();
    this.preparation ??= prepareWorkspace(
      this.workspaces,
      this.store,
      this.job,
      signal,
    );
    return this.preparation;
  }
  private files<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    const task = operation(AbortSignal.any([signal, this.controller.signal]));
    this.fileTasks.add(task);
    void task.finally(() => this.fileTasks.delete(task)).catch(() => {});
    return task;
  }
  read(path: string, signal: AbortSignal, offset = 0) {
    return this.files(signal, async (signal) => {
      this.authorize();
      if (this.busy)
        throw new AppError("capacity", "请等待当前脚本完成后读取文件。");
      const paths = await this.paths(signal);
      const root = path.startsWith("/inputs") ? paths.inputs : paths.workspace;
      const relative = path.replace(/^\/(?:inputs|workspace)\/?/, "");
      try {
        const listed = await readGrantedPath(
          root,
          { action: "list", grantId: this.job.id, path: relative, offset },
          signal,
        );
        if (listed.action !== "list")
          throw new AppError("internal", "目录读取响应不匹配。");
        this.authorize();
        return {
          type: "directory" as const,
          entries: listed.entries,
          nextOffset: listed.nextOffset,
        };
      } catch (error) {
        if (!(error instanceof AppError && error.code === "invalid_input"))
          throw error;
      }
      const bytes = await readGrantedBytes(root, relative, signal);
      this.authorize();
      return { type: "file" as const, bytes };
    });
  }
  stage(name: string, bytes: Buffer, signal: AbortSignal) {
    return this.files(signal, async (signal) => {
      const paths = await this.paths(signal);
      signal.throwIfAborted();
      const key = createHash("sha256").update(bytes).digest("hex");
      const old = this.staged.get(key);
      if (old) return old;
      const received = this.job.attachments.reduce(
        (size, attachment) => size + attachment.size,
        0,
      );
      if (received + this.stagedBytes + bytes.length > 200 * 1024 * 1024)
        throw new AppError("capacity", "本轮输入副本超过 200 MiB。");
      const extension =
        /\.[a-z0-9]{1,10}$/i.exec(name)?.[0].toLowerCase() ?? ".bin";
      const file = `read-${key}${extension}`;
      this.stagedBytes += bytes.length;
      const path = `/inputs/${file}`;
      const staged = (async () => {
        await writeFile(join(paths.inputs, file), bytes, {
          flag: "wx",
          mode: 0o444,
        });
        this.authorize();
        signal.throwIfAborted();
        return path;
      })();
      this.staged.set(key, staged);
      return staged;
    });
  }
  private authorize() {
    this.controller.signal.throwIfAborted();
    if (
      !this.store.runs.canWrite(this.job) ||
      this.store.runs.getRun(this.job.id)?.status !== "running"
    )
      throw new AppError("unauthorized", "脚本工具运行授权已结束。");
  }
  request(value: unknown, signal: AbortSignal): Promise<ScriptResult> {
    this.authorize();
    signal.throwIfAborted();
    const request = scriptRequestSchema.parse(value);
    this.acquire();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request.operation))
      .digest("hex");
    const previous = this.calls.get(request.callId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError("conflict", "同一次脚本工具调用不能更改参数。");
      return previous.result;
    }
    if (this.calls.size >= 100)
      throw new AppError("capacity", "本轮脚本工具请求超过 100 次。");
    const operation = request.operation;
    const result = (async (): Promise<ScriptResult> => {
      if (operation.action === "status") {
        const resources = this.resources.view();
        return {
          action: "status",
          state: this.ready
            ? "running"
            : this.process
              ? "preparing"
              : resources.state,
          detail: this.ready
            ? "Linux 脚本沙箱已启动。"
            : this.process
              ? "正在准备并校验脚本环境；脚本尚未执行。"
              : resources.detail,
          workspace: "/workspace",
          inputs: this.job.attachments.map((a) => ({
            id: a.id,
            name: a.name,
            path: scriptInputPath(a),
          })),
        };
      }
      if (this.busy)
        throw new AppError(
          "capacity",
          "当前 Bot 正在等待批准或执行脚本，请等待它完成。",
        );
      if (operation.action === "list")
        return {
          action: "list",
          entries: await listScriptFiles(this.workspace, operation.path),
        };
      if (operation.action === "export") {
        const receipt = {
          callId: `script:${this.scopeId}:${request.callId}`,
          fingerprint,
        };
        const prior = this.store.files.fileToolReplay(
          this.job,
          receipt.callId,
          fingerprint,
        );
        if (prior) return { action: "export", attachment: prior };
        const bytes = await readScriptFile(this.workspace, operation.path);
        this.authorize();
        signal.throwIfAborted();
        const attachment = this.store.files.saveAgentFile(
          this.job,
          operation.name,
          bytes,
          receipt,
        );
        if (!attachment)
          throw new AppError("unauthorized", "运行结束，脚本成果未提交。");
        return { action: "export", attachment };
      }
      this.busy = true;
      try {
        return {
          action: "exec",
          result: await this.execute(
            request.callId,
            {
              type: "script",
              command: operation.command,
              network: [...new Set(operation.network)].sort(),
            },
            signal,
          ),
        };
      } finally {
        this.busy = false;
      }
    })();
    this.calls.set(request.callId, { fingerprint, result });
    return result;
  }
  private approved(id: string, signal: AbortSignal) {
    return new Promise<boolean>((resolve, reject) => {
      const finish = (value?: boolean, error?: unknown) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value ?? false);
      };
      const check = () => {
        try {
          this.authorize();
          const call = this.store.toolOperations.toolGet(id);
          if (
            call.status === "approved" &&
            this.store.toolOperations.toolClaim(this.job, id)
          )
            finish(true);
          else if (!["pending", "approved", "running"].includes(call.status))
            finish(false);
        } catch (error) {
          finish(undefined, error);
        }
      };
      const abort = () => {
        this.store.toolOperations.toolCancel(id);
        finish(undefined, signal.reason);
      };
      const unsubscribe = this.store.subscribe(check);
      const timer = setTimeout(
        () => {
          this.store.toolOperations.toolFinish(
            id,
            "expired",
            "等待脚本审批超过五分钟，未执行。",
          );
          check();
        },
        Math.max(
          0,
          this.store.toolOperations.toolGet(id).expiresAt - Date.now(),
        ),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }
  private async execute(
    callId: string,
    action: ScriptAction,
    transport: AbortSignal,
  ): Promise<ScriptExecution> {
    const signal = AbortSignal.any([transport, this.controller.signal]);
    const call = this.store.toolOperations.toolRequest(
      this.job,
      `script:${this.scopeId}:${callId}`,
      action,
      !!this.approvals,
    );
    const abort = () => this.cancel();
    transport.addEventListener("abort", abort, { once: true });
    const itemId = `script:${call.id}`;
    const tool: ToolExecution = {
      kind: "command",
      command: action.command,
      cwd: "/workspace",
      status: "running",
      output: "",
      exitCode: null,
      durationMs: null,
      truncated: false,
    };
    try {
      await this.approvals?.review(this.job, call.id, action, signal);
      if (!(await this.approved(call.id, signal))) {
        const status = this.store.toolOperations.toolGet(call.id).status;
        return {
          status:
            status === "expired"
              ? "expired"
              : status === "cancelled"
                ? "cancelled"
                : "declined",
          stdout: "",
          stderr: "本次脚本未获批准，未执行。",
          exitCode: null,
          truncated: false,
          durationMs: 0,
        };
      }
      this.authorize();
      if (
        this.network &&
        JSON.stringify(this.network) !== JSON.stringify(action.network)
      )
        throw new AppError(
          "conflict",
          "同一轮沙箱的网络范围已固定；需要不同网络范围时请开始新一轮，后续命令需保持原范围。",
        );
      this.store.runs.output.writeTool(this.job, itemId, tool);
      this.preparation ??= prepareWorkspace(
        this.workspaces,
        this.store,
        this.job,
        signal,
      );
      const paths = await this.preparation;
      this.authorize();
      signal.throwIfAborted();
      if (!this.process) {
        await this.resources.wait(signal, (detail) => {
          this.store.toolOperations.toolFinish(call.id, "running", detail);
        });
        this.authorize();
        signal.throwIfAborted();
        this.network = action.network;
        this.process = new SandboxProcess(this.controller.signal, (detail) =>
          this.store.toolOperations.toolFinish(call.id, "running", detail),
        );
        await this.process.open({
          ...paths,
          quotaMiB: await scriptWorkspaceQuota(paths.workspace, signal),
          home: join(this.root, "runtime"),
          assets: join(this.root, "assets"),
          name: `aster-script-${this.job.botId}`,
          network: action.network,
          configuration: (await this.settings.read()).configuration,
        });
        this.ready = true;
      }
      this.authorize();
      signal.throwIfAborted();
      this.store.toolOperations.toolFinish(
        call.id,
        "running",
        "Linux 隔离环境已就绪，正在执行已批准的脚本…",
      );
      const result = await this.process.execute(action.command);
      const budget = 65536 - 20;
      const out = result.stdout.slice(
        0,
        budget - Math.min(result.stderr.length, Math.floor(budget / 2)),
      );
      const err = result.stderr.slice(0, budget - out.length);
      const output = `stdout:\n${out}\nstderr:\n${err}`;
      this.store.runs.output.writeTool(this.job, itemId, {
        ...tool,
        status: result.status === "completed" ? "completed" : "failed",
        output: output.slice(0, 65536),
        truncated:
          result.truncated ||
          out.length < result.stdout.length ||
          err.length < result.stderr.length,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      this.store.toolOperations.toolFinish(
        call.id,
        result.status,
        `脚本${result.status === "completed" ? "完成" : "失败"}，退出码 ${result.exitCode ?? "未返回"}${result.truncated ? "，输出已截断" : ""}。`,
      );
      if (result.exitCode === null) {
        await this.process.close();
        this.process = undefined;
        this.ready = false;
      }
      return result;
    } catch (cause) {
      let error = cause;
      try {
        await this.process?.close();
        this.process = undefined;
      } catch (cleanup) {
        error = new AppError(
          "unknown",
          cleanup instanceof Error ? cleanup.message : "脚本沙箱清理未确认。",
        );
      }
      this.ready = false;
      const unknown = error instanceof AppError && error.code === "unknown";
      this.store.toolOperations.toolFinish(
        call.id,
        unknown ? "unknown" : signal.aborted ? "cancelled" : "failed",
        error instanceof Error ? error.message : "脚本执行失败。",
      );
      this.store.runs.output.writeTool(this.job, itemId, {
        ...tool,
        status: unknown ? "unknown" : "failed",
        output:
          error instanceof Error
            ? error.message.slice(0, 65536)
            : "脚本执行失败。",
      });
      throw error;
    } finally {
      transport.removeEventListener("abort", abort);
    }
  }
  close() {
    return (this.closing ??= (async () => {
      this.cancel();
      this.signal.removeEventListener("abort", this.abort);
      await this.process?.close();
      await Promise.allSettled(
        [...this.calls.values()].map((call) => call.result),
      );
      await Promise.allSettled([...this.fileTasks]);
      if (this.preparation)
        await clearScriptInputs(this.workspaces, this.job.botId, this.job.id);
    })());
  }
}
