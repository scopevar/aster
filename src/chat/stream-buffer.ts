import type { StreamEntry } from "../storage/runs/stream-entry.js";
/**
 * 把逐 token 的文本与工具输出合并成少量落库事务。
 * 数据库仍是唯一事实源，本缓冲只改变写入粒度，不构成第二份状态：
 * 任何状态变更（工具、线程、终态）之前都必须先 flush，保证落库顺序等于事件顺序。
 */
// [Perf]: synchronous=FULL 下每个事务一次 fsync；以窗口合并把每 token 一次降为每窗口一次。
const flushAfterMs = 100;
const flushAtChars = 4096;

export class StreamBuffer {
  private readonly pending = new Map<string, StreamEntry>();
  private chars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deferred: unknown;
  private closed = false;
  constructor(private readonly sink: (entries: StreamEntry[]) => void) {}
  text(itemId: string, text: string, complete: boolean) {
    this.rethrowDeferred();
    if (this.closed) {
      this.sink([{ kind: "text", itemId, text, replace: complete }]);
      return;
    }
    const key = `text:${itemId}`;
    const previous = this.pending.get(key);
    if (complete) {
      // 规范文本覆盖本 item 的未落库增量；其余 item 的缓冲顺序保持不变。
      if (previous) this.chars -= entryChars(previous);
      this.pending.set(key, { kind: "text", itemId, text, replace: true });
      this.chars += text.length;
      this.flush();
      return;
    }
    if (previous?.kind === "text") {
      previous.text += text;
      this.chars += text.length;
    } else {
      this.pending.set(key, { kind: "text", itemId, text, replace: false });
      this.chars += text.length;
    }
    this.schedule();
  }
  toolOutput(itemId: string, delta: string) {
    this.rethrowDeferred();
    if (this.closed) {
      this.sink([{ kind: "tool-output", itemId, delta }]);
      return;
    }
    const key = `tool-output:${itemId}`;
    const previous = this.pending.get(key);
    if (previous?.kind === "tool-output") previous.delta += delta;
    else this.pending.set(key, { kind: "tool-output", itemId, delta });
    this.chars += delta.length;
    this.schedule();
  }
  /** 状态变更前的同步排空；失败直接抛给调用方，与逐 token 写入时的语义一致。 */
  flush() {
    this.clearTimer();
    this.rethrowDeferred();
    if (!this.pending.size) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.chars = 0;
    this.sink(entries);
  }
  /** 排空并关闭；关闭后到达的迟到事件直接落库，不再缓冲，避免留下未刷写的尾巴。 */
  close() {
    this.closed = true;
    this.flush();
  }
  /**
   * 运行已因其它原因失败时的收尾：尽力落库已缓冲内容，但不让二次失败掩盖原始错误
   * （真正的库故障会在随后的 finish 写入终态时再次暴露）。
   */
  closeQuietly() {
    this.closed = true;
    this.clearTimer();
    this.deferred = undefined;
    try {
      this.flush();
    } catch {
      this.pending.clear();
      this.chars = 0;
    }
  }
  private schedule() {
    if (this.chars >= flushAtChars) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (error) {
        // 定时器里没有调用方可以承接异常；留到下一个事件或收尾时抛出。
        this.deferred = error;
      }
    }, flushAfterMs);
  }
  private clearTimer() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private rethrowDeferred() {
    const error = this.deferred;
    if (error === undefined) return;
    this.deferred = undefined;
    throw error;
  }
}

function entryChars(entry: StreamEntry) {
  return entry.kind === "text" ? entry.text.length : entry.delta.length;
}
