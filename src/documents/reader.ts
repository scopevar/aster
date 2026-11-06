import {
  officeOperationSchema,
  officeResultSchema,
  type OfficeKind,
  type OfficeOperation,
  type OfficeResult,
} from "../shared/files/office.js";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { AppError, failureSchema } from "../shared/core.js";
import {
  pdfOperationSchema,
  pdfResultSchema,
  type PdfOperation,
  type PdfResult,
} from "../shared/files/documents.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import { VideoReader } from "../video/reader.js";
import type { VideoOperation } from "../shared/files/video.js";

/** Owns every parser thread until termination; cancellation waits for actual release. */
export class DocumentReader {
  private readonly video = new VideoReader();
  readVideo(
    bytes: Uint8Array,
    name: string,
    operation: VideoOperation,
    signal: AbortSignal,
  ) {
    if (this.closing) throw new AppError("unavailable", "文档服务正在关闭。");
    return this.video.read(bytes, name, operation, signal);
  }
  private closing = false;
  private occupied = 0;
  private readonly queued = new Set<{ start(): void; stop(): void }>();
  private readonly tasks = new Set<Promise<unknown>>();
  private active = new Set<{ worker: Worker; finished: Promise<void> }>();
  constructor(
    private readonly executable: URL,
    private readonly officeExecutable = new URL(
      "./office-worker.js",
      executable,
    ),
  ) {}

  async read(
    bytes: Uint8Array,
    operation: PdfOperation,
    signal: AbortSignal,
  ): Promise<PdfResult> {
    return this.execute(
      this.executable,
      { bytes, operation: pdfOperationSchema.parse(operation) },
      bytes.byteLength,
      pdfResultSchema,
      signal,
    );
  }
  async readOffice(
    bytes: Uint8Array,
    name: string,
    kind: OfficeKind,
    operation: OfficeOperation,
    signal: AbortSignal,
  ): Promise<OfficeResult> {
    return this.execute(
      this.officeExecutable,
      { bytes, name, kind, operation: officeOperationSchema.parse(operation) },
      bytes.byteLength,
      officeResultSchema,
      signal,
    );
  }
  private execute<R>(
    executable: URL,
    workerData: unknown,
    size: number,
    result: z.ZodType<R>,
    signal: AbortSignal,
  ): Promise<R> {
    const task = this.run(executable, workerData, size, result, signal);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  private acquire(signal: AbortSignal, deadline: number): Promise<void> {
    signal.throwIfAborted();
    if (this.closing) throw new AppError("unavailable", "文档服务正在关闭。");
    if (this.occupied < 2) {
      this.occupied++;
      return Promise.resolve();
    }
    if (this.queued.size >= 6)
      throw new AppError("capacity", "文档读取队列已满，请稍后重试。");
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.queued.delete(entry);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const abort = () => fail(signal.reason);
      const entry = {
        start: () => {
          cleanup();
          this.occupied++;
          resolve();
        },
        stop: () => fail(new AppError("unavailable", "文档服务正在关闭。")),
      };
      const timer = setTimeout(
        () =>
          fail(new AppError("unavailable", "文档读取等待超过 20 秒，已停止。")),
        Math.max(1, deadline - Date.now()),
      );
      this.queued.add(entry);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private release() {
    this.occupied--;
    if (!this.closing) this.queued.values().next().value?.start();
  }
  private async run<R>(
    executable: URL,
    workerData: unknown,
    size: number,
    result: z.ZodType<R>,
    signal: AbortSignal,
  ): Promise<R> {
    const resultSchema = z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), result }).strict(),
      z.object({ ok: z.literal(false), error: failureSchema }).strict(),
    ]);
    signal.throwIfAborted();
    if (this.closing) throw new AppError("unavailable", "文档服务正在关闭。");
    if (size > maxAttachmentBytes)
      throw new AppError("capacity", "文档最多 25 MiB。");
    const deadline = Date.now() + 20000;
    await this.acquire(signal, deadline);
    let worker: Worker;
    try {
      signal.throwIfAborted();
      if (this.closing) throw new AppError("unavailable", "文档服务正在关闭。");
      worker = new Worker(executable, {
        workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (error) {
      this.release();
      throw error;
    }
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { worker, finished };
    this.active.add(entry);
    return new Promise<R>((resolve, reject) => {
      let settling = false;
      const settle = (result: R | null, error?: unknown) => {
        if (settling) return;
        settling = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        void worker
          .terminate()
          .then(
            () => {
              if (error) reject(error);
              else if (signal.aborted) reject(signal.reason);
              else if (result) resolve(result);
              else reject(new AppError("internal", "文档处理未返回结果。"));
            },
            (error) => reject(error),
          )
          .finally(() => {
            this.active.delete(entry);
            this.release();
            finish();
          });
      };
      const abort = () => settle(null, signal.reason);
      const timer = setTimeout(
        () =>
          settle(
            null,
            new AppError(
              "unavailable",
              "文档处理超过 20 秒，已停止。请缩小文件或页面后重试。",
            ),
          ),
        Math.max(1, deadline - Date.now()),
      );
      worker.once("message", (value: unknown) => {
        const parsed = resultSchema.safeParse(value);
        if (!parsed.success)
          settle(null, new AppError("internal", "文档处理返回了无效数据。"));
        else if (!parsed.data.ok)
          settle(
            null,
            new AppError(parsed.data.error.code, parsed.data.error.message),
          );
        else settle(parsed.data.result);
      });
      worker.once("error", () =>
        settle(
          null,
          new AppError(
            "unavailable",
            "文档处理进程失败或超过内存限制，原文件仍保留。",
          ),
        ),
      );
      worker.once("exit", () =>
        settle(null, new AppError("unavailable", "文档处理在返回结果前结束。")),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async close() {
    this.closing = true;
    const videoClosed = this.video.close();
    for (const entry of [...this.queued]) entry.stop();
    const entries = [...this.active];
    await Promise.allSettled(entries.map((entry) => entry.worker.terminate()));
    await Promise.all(entries.map((entry) => entry.finished));
    await Promise.allSettled([...this.tasks]);
    await videoClosed;
  }
}
