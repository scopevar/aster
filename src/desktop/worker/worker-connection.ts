import { AppError } from "../../shared/core.js";
import type { Endpoint } from "../../platform/endpoint.js";
import {
  readWorker,
  callWorker,
  openWorkerStream,
} from "../../worker/client.js";

/**
 * 缓存 worker endpoint，避免每次请求都读 endpoint.json 并做一次 /health。
 * 只有请求失败时才重新解析，因此后台重启、换端口或轮换 token 仍会被发现。
 */
export class WorkerConnection {
  private cached: Promise<Endpoint> | undefined;
  constructor(private readonly directory: string) {}
  endpoint(): Promise<Endpoint> {
    return (this.cached ??= readWorker(this.directory).catch(
      (error: unknown) => {
        this.cached = undefined;
        throw error;
      },
    ));
  }
  invalidate() {
    this.cached = undefined;
  }
  /** 订阅是幂等 GET，任何打开失败都作废缓存，下次重连重新解析 endpoint。 */
  async stream(path: string, signal: AbortSignal) {
    const endpoint = await this.endpoint();
    try {
      return await openWorkerStream(endpoint, path, signal);
    } catch (error) {
      if (!signal.aborted) this.invalidate();
      throw error;
    }
  }
  /**
   * [Invariant]: 只有在请求尚未到达任何 worker 时才重试（连接被拒），
   * 否则命令可能已被提交，重试要由调用方凭原请求 ID 决定。
   */
  async call(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const endpoint = await this.endpoint();
    try {
      return await callWorker(endpoint, path, body, signal, timeoutMs);
    } catch (error) {
      if (!unreached(error)) {
        if (error instanceof AppError && error.code === "unauthorized")
          this.invalidate();
        throw error;
      }
      this.invalidate();
      const next = await this.endpoint();
      if (next.port === endpoint.port && next.token === endpoint.token)
        throw error;
      return callWorker(next, path, body, signal, timeoutMs);
    }
  }
}

/** 连接层失败：请求没有到达任何进程，重发不会造成重复执行。 */
function unreached(error: unknown) {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "ECONNREFUSED") return true;
  const cause = error.cause;
  return (
    cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED"
  );
}
