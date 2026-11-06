import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "../../shared/core.js";
import {
  sameCursor,
  storeCursorSchema,
  workerEventTiming,
  type WorkerSignal,
} from "../../shared/worker-events.js";

export type WorkerStream = (
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

export type FeedTiming = {
  staleAfterMs: number;
  retryMinMs: number;
  retryMaxMs: number;
};

const defaultTiming: FeedTiming = {
  staleAfterMs: workerEventTiming.staleAfterMs,
  retryMinMs: 250,
  retryMaxMs: 5000,
};

/** 单个事件块的上限；worker 只发送几十字节的游标，超限说明对端不是预期的服务。 */
const maxPendingChars = 64 * 1024;

/** 最小 SSE 解析：只取 data 行，注释行（心跳）只用来喂看门狗。 */
export class EventParser {
  private pending = "";
  push(chunk: string): string[] {
    this.pending += chunk;
    const events: string[] = [];
    let boundary = this.pending.indexOf("\n\n");
    while (boundary !== -1) {
      const data = this.pending
        .slice(0, boundary)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) events.push(data);
      this.pending = this.pending.slice(boundary + 2);
      boundary = this.pending.indexOf("\n\n");
    }
    if (this.pending.length > maxPendingChars)
      throw new AppError("unavailable", "后台事件过大。");
    return events;
  }
}

function sameSignal(a: WorkerSignal, b: WorkerSignal) {
  if (a.state === "offline" || b.state === "offline")
    return a.state === b.state;
  return sameCursor(a.cursor, b.cursor);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 维持一条到 worker 的事件流，把“数据已变化”的提示转为 WorkerSignal。
 * 断线后指数退避重连；重连成功的首个事件总是当前游标，订阅者据此补拉，不会漏更新。
 */
export class WorkerFeed {
  private current: WorkerSignal = { state: "offline" };
  private readonly listeners = new Set<(signal: WorkerSignal) => void>();
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private readonly timing: FeedTiming;
  constructor(
    private readonly open: WorkerStream,
    timing: Partial<FeedTiming> = {},
  ) {
    this.timing = { ...defaultTiming, ...timing };
  }
  status(): WorkerSignal {
    return this.current;
  }
  subscribe(listener: (signal: WorkerSignal) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start() {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal);
  }
  async stop() {
    this.controller?.abort();
    this.controller = undefined;
    await this.running;
    this.running = undefined;
  }
  private async run(stop: AbortSignal) {
    let attempt = 0;
    while (!stop.aborted) {
      try {
        if (await this.follow(stop)) attempt = 0;
      } catch {
        // 连接被拒、鉴权失败、心跳超时或载荷无效都按同一策略退避重连；原因不改变恢复方式。
      }
      if (stop.aborted) return;
      this.update({ state: "offline" }, stop);
      const delay = Math.min(
        this.timing.retryMaxMs,
        this.timing.retryMinMs * 2 ** attempt,
      );
      attempt += 1;
      try {
        await sleep(delay, undefined, { signal: stop });
      } catch {
        return;
      }
    }
  }
  /** 返回本次连接是否收到过有效游标，用于重置退避。 */
  private async follow(stop: AbortSignal): Promise<boolean> {
    const watchdog = new AbortController();
    const signal = AbortSignal.any([stop, watchdog.signal]);
    let timer = setTimeout(() => watchdog.abort(), this.timing.staleAfterMs);
    let received = false;
    let cancelReader: (() => void) | undefined;
    try {
      const body = await this.open(signal);
      const reader = body.getReader();
      // The daemon outlives Main. Explicitly release its stream instead of
      // relying on server shutdown to finish an outstanding Electron read.
      cancelReader = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancelReader, { once: true });
      if (signal.aborted) cancelReader();
      const decoder = new TextDecoder();
      const parser = new EventParser();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return received;
        clearTimeout(timer);
        timer = setTimeout(() => watchdog.abort(), this.timing.staleAfterMs);
        // [Invariant]: stream 模式保留跨 chunk 截断的多字节字符，避免中文等字符被拆成乱码。
        const text = decoder.decode(chunk.value, { stream: true });
        for (const data of parser.push(text)) {
          const cursor = storeCursorSchema.safeParse(parseJson(data));
          if (!cursor.success)
            throw new AppError("unavailable", "后台事件格式无效。");
          received = true;
          this.update({ state: "live", cursor: cursor.data }, stop);
        }
      }
    } finally {
      if (cancelReader) signal.removeEventListener("abort", cancelReader);
      clearTimeout(timer);
      // [Lifecycle]: 无论正常结束还是抛错都中止请求，确保底层 socket 随本次连接一起释放。
      watchdog.abort();
    }
  }
  /** [Invariant]: stop() 之后迟到的事件不得再通知订阅者，避免窗口销毁后仍向其发送。 */
  private update(next: WorkerSignal, stop: AbortSignal) {
    if (stop.aborted || sameSignal(this.current, next)) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
