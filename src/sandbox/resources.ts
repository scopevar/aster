import { join } from "node:path";
import { AppError } from "../shared/core.js";
import { SandboxProcess } from "./process.js";

/** Account-owned preparation outlives individual chat waiters, but never its daemon session. */
export class SandboxResources {
  private task: Promise<void> | undefined;
  private process: SandboxProcess | undefined;
  private controller: AbortController | undefined;
  private ready = false;
  private stopped = false;
  private detail = "固定脚本资源尚未准备，将在后台下载并支持断点续传。";
  private readonly listeners = new Set<(detail: string) => void>();
  constructor(private readonly directory: string) {}

  view() {
    return {
      state: this.ready
        ? ("ready" as const)
        : this.task
          ? ("preparing" as const)
          : ("unprepared" as const),
      detail: this.detail,
    };
  }
  start() {
    if (this.stopped || this.ready || this.task) return;
    this.controller = new AbortController();
    const child = new SandboxProcess(this.controller.signal, (detail) => {
      this.detail = detail;
      for (const listener of this.listeners) listener(detail);
    });
    this.process = child;
    this.detail = "正在后台准备固定脚本资源；支持断点续传，脚本尚未执行。";
    const prepare = async () => {
      try {
        await child.prepare({
          home: join(this.directory, "runtime"),
          assets: join(this.directory, "assets"),
        });
      } finally {
        await child.close();
      }
      this.ready = true;
    };
    this.task = prepare()
      .catch((error: unknown) => {
        this.detail =
          error instanceof Error ? error.message : "脚本资源准备失败，可重试。";
        throw error;
      })
      .finally(() => {
        this.task = undefined;
      });
    // Failure is retained for status/retry; startup must not fail or leave an unhandled rejection.
    void this.task.catch(() => {});
  }
  wait(signal: AbortSignal, status: (detail: string) => void) {
    signal.throwIfAborted();
    if (this.stopped)
      throw new AppError("unavailable", "脚本资源服务正在停止。");
    if (this.ready) return Promise.resolve();
    this.start();
    status(this.detail);
    this.listeners.add(status);
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        signal.removeEventListener("abort", abort);
        this.listeners.delete(status);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else void this.task?.then(() => finish(), finish);
    });
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.process?.close();
    await this.task?.catch(() => {});
    this.listeners.clear();
  }
}
