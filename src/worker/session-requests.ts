import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "../shared/core.js";

/** A data session must retain its Store until every admitted handler settles. */
export class SessionRequests {
  private accepting = true;
  private closed = false;
  private readonly active = new Map<Promise<unknown>, AbortController>();

  async run<T>(
    request: IncomingMessage,
    response: ServerResponse,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 35_000,
  ): Promise<T> {
    if (!this.accepting)
      throw new AppError("unavailable", "账户正在切换，请稍候再试。");
    const controller = new AbortController();
    const cancel = () => {
      // [Lifecycle]: End the response before destroying an incomplete upload, so the caller receives an explicit cancellation.
      if (!response.writableEnded && !response.destroyed) {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(503, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.end(
            JSON.stringify({
              error: {
                code: "unavailable",
                message: "请求已取消，账户数据正在切换或后台正在停止。",
              },
            }),
            () => request.destroy(),
          );
          return;
        }
      }
      if (!request.complete) request.destroy();
    };
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    response.once("close", disconnected);
    const timer = setTimeout(
      () => controller.abort(new AppError("unavailable", "请求已超时。")),
      timeoutMs,
    );
    const task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    });
    this.active.set(task, controller);
    try {
      return await task;
    } finally {
      clearTimeout(timer);
      this.active.delete(task);
      controller.signal.removeEventListener("abort", cancel);
      response.removeListener("close", disconnected);
    }
  }

  async pause() {
    this.accepting = false;
    for (const controller of this.active.values())
      controller.abort(new AppError("unavailable", "账户数据正在切换。"));
    await Promise.allSettled([...this.active.keys()]);
  }

  resume() {
    if (!this.closed) this.accepting = true;
  }

  close() {
    this.closed = true;
    return this.pause();
  }
}
