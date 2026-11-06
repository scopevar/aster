import type { Client } from "@modelcontextprotocol/client";
import { AppError } from "../shared/core.js";
import { pluginToolRequestSchema } from "../shared/tools/plugins.js";
import type { Job, Store } from "../storage/store.js";
import { connectPlugin } from "./connection.js";
import type { PluginOAuth } from "./oauth.js";

type Connection = { client: Client; close(): Promise<void> };
/** One live Bot run; plugin changes revoke connections and pending calls. */
export class PluginSession {
  private readonly controller = new AbortController();
  private connections = new Map<
    string,
    { fingerprint: string; promise: Promise<Connection>; tools: Set<string> }
  >();
  private calls = new Map<string, Promise<unknown>>();
  private readonly signal: AbortSignal;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly store: Pick<
      Store,
      | "pluginCalls"
      | "plugins"
      | "routineOperations"
      | "runs"
      | "subscribe"
      | "views"
    >,
    private readonly job: Job,
    signal: AbortSignal,
    private readonly oauth?: PluginOAuth,
  ) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.unsubscribe = store.subscribe(() => {
      try {
        this.authorize();
        for (const [key, connection] of this.connections) {
          const id = key.split("/")[0] ?? "";
          if (
            JSON.stringify(store.plugins.execution(job.botId, id)) !==
            connection.fingerprint
          ) {
            this.cancel();
            break;
          }
        }
      } catch {
        this.cancel();
      }
    });
  }
  cancel() {
    this.controller.abort();
  }
  async close() {
    this.cancel();
    this.unsubscribe();
    await Promise.allSettled([...this.calls.values()]);
    const results = await Promise.allSettled(
      [...this.connections.values()].map(async ({ promise }) => {
        const connection = await promise.catch(() => null);
        await connection?.close();
      }),
    );
    this.connections.clear();
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
  private authorize() {
    this.signal.throwIfAborted();
    if (
      this.job.groupOrdinal !== undefined ||
      !this.store.runs.canWrite(this.job) ||
      this.store.runs.getRun(this.job.id)?.status !== "running"
    )
      throw new AppError(
        "unauthorized",
        "插件工具运行授权已结束或当前为群聊。",
      );
    this.store.plugins.list([this.job.botId]);
  }
  private async connection(pluginId: string, server: string) {
    this.authorize();
    const execution = this.store.plugins.execution(this.job.botId, pluginId);
    const config = execution.content.servers[server];
    if (!config) throw new AppError("not_found", "插件 MCP 服务不存在。");
    const key = `${pluginId}/${server}`,
      fingerprint = JSON.stringify(execution);
    let entry = this.connections.get(key);
    if (!entry) {
      if (this.connections.size >= 16)
        throw new AppError("capacity", "本轮插件 MCP 连接过多。");
      const promise = connectPlugin(
        execution.content,
        config,
        execution.variables,
        this.signal,
        await this.oauth?.transport(
          this.job.botId,
          pluginId,
          server,
          this.signal,
        ),
      );
      entry = { fingerprint, promise, tools: new Set() };
      this.connections.set(key, entry);
    }
    if (entry.fingerprint !== fingerprint)
      throw new AppError("conflict", "插件配置已变更，请开始新一轮会话。");
    const connection = await entry.promise;
    this.authorize();
    return { ...connection, tools: entry.tools };
  }
  async request(value: unknown, signal: AbortSignal): Promise<unknown> {
    this.authorize();
    signal.throwIfAborted();
    const request = pluginToolRequestSchema.parse(value);
    if (request.operation.action === "list") {
      const catalog: unknown[] = [],
        errors: Array<{ pluginId: string; server: string; message: string }> =
          [];
      for (const plugin of this.store.plugins
        .list([this.job.botId])
        .filter((plugin) => plugin.enabled)) {
        for (const server of plugin.servers) {
          try {
            const connection = await this.connection(plugin.id, server.name);
            let cursor: string | undefined;
            const cursors = new Set<string>();
            for (let page = 0; page < 10; page++) {
              const listed = await connection.client.listTools(
                cursor ? { cursor } : {},
                {
                  signal: AbortSignal.any([this.signal, signal]),
                  timeout: 15000,
                },
              );
              for (const tool of listed.tools) {
                if (catalog.length >= 200)
                  throw new AppError("capacity", "插件工具目录超过 200 项。");
                connection.tools.add(tool.name);
                catalog.push({
                  ...tool,
                  pluginId: plugin.id,
                  pluginName: plugin.name,
                  server: server.name,
                });
              }
              if (!listed.nextCursor) break;
              if (page === 9 || cursors.has(listed.nextCursor))
                throw new AppError("capacity", "插件工具分页未完整结束。");
              cursors.add(listed.nextCursor);
              cursor = listed.nextCursor;
            }
          } catch (error) {
            this.authorize();
            signal.throwIfAborted();
            errors.push({
              pluginId: plugin.id,
              server: server.name,
              message:
                error instanceof AppError
                  ? error.message
                  : "工具发现失败，请检查 MCP 配置。",
            });
          }
        }
      }
      if (Buffer.byteLength(JSON.stringify(catalog)) > 512 * 1024)
        throw new AppError("capacity", "插件工具目录超过大小限制。");
      return { tools: catalog, errors };
    }
    const operation = request.operation;
    const execution = this.store.plugins.execution(
      this.job.botId,
      operation.pluginId,
    );
    const connection = await this.connection(
      operation.pluginId,
      operation.server,
    );
    if (!connection.tools.has(operation.tool))
      throw new AppError(
        "invalid_input",
        "请先通过 plugins list 发现当前插件工具。",
      );
    if (this.calls.size >= 4)
      throw new AppError("capacity", "同时等待的插件调用过多。");
    const record = this.store.pluginCalls.create(
      this.job,
      request.callId,
      execution.content.name,
      operation,
    );
    const previous = this.calls.get(record.id);
    if (previous) return previous;
    if (!["pending", "approved"].includes(record.status))
      return this.store.pluginCalls.result(record.id);
    const active = AbortSignal.any([
      this.signal,
      signal,
      AbortSignal.timeout(5 * 60 * 1000),
    ]);
    const call = (async () => {
      let started = false;
      try {
        await this.awaitDecision(record.id, active);
        if (this.store.pluginCalls.get(record.id).status === "declined") {
          if (this.store.routineOperations.isRun(this.job.id))
            this.store.runs.finish(
              this.job.id,
              "cancelled",
              "用户拒绝了高风险工具调用，本次运行已结束。",
            );
          return this.store.pluginCalls.result(record.id);
        }
        this.authorize();
        if (!this.store.pluginCalls.claim(this.job, record.id))
          return this.store.pluginCalls.result(record.id);
        started = true;
        const result = await connection.client.callTool(
          { name: operation.tool, arguments: operation.arguments },
          { signal: active, timeout: 60000 },
        );
        active.throwIfAborted();
        this.authorize();
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          throw new AppError("capacity", "插件工具结果超过大小限制。");
        this.store.pluginCalls.finish(
          record.id,
          "completed",
          "执行已返回；工具错误详见结果。",
          result,
        );
        return result;
      } catch {
        this.store.pluginCalls.finish(
          record.id,
          started ? "unknown" : "cancelled",
          started
            ? "调用已开始，但结果未确认；请核实实际状态，不会自动重试。"
            : "等待已取消或授权结束，未执行。",
        );
        return this.store.pluginCalls.result(record.id);
      } finally {
        this.calls.delete(record.id);
      }
    })();
    this.calls.set(record.id, call);
    return call;
  }
  private awaitDecision(id: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const dispose = () => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const check = () => {
        try {
          const call = this.store.pluginCalls.get(id);
          if (call.status !== "pending") {
            dispose();
            resolve();
          }
        } catch (error) {
          dispose();
          reject(error);
        }
      };
      const abort = () => {
        dispose();
        reject(new AppError("unavailable", "插件调用已取消。"));
      };
      unsubscribe = this.store.subscribe(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }
}
