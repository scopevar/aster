import { AppError } from "../shared/core.js";
import {
  documentRequestSchema,
  type DocumentResult,
} from "../shared/files/documents.js";
import { officeReadOperationSchema } from "../shared/files/office.js";
import { videoOperationSchema } from "../shared/files/video.js";
import type { Job, Store } from "../storage/store.js";
import type { DocumentReader } from "./reader.js";

/** A runtime scope owns all requests; close revokes access and waits for parser termination. */
export class DocumentSession {
  private readonly lifetime = new AbortController();
  private readonly calls = new Map<
    string,
    { fingerprint: string; task: Promise<DocumentResult> }
  >();
  private failure: unknown;
  private attempts = 0;
  constructor(
    private readonly store: Pick<Store, "documentOperations">,
    private readonly reader: DocumentReader,
    private readonly job: Job,
  ) {}
  cancel() {
    this.lifetime.abort();
  }
  async close() {
    this.cancel();
    await Promise.allSettled([...this.calls.values()].map((call) => call.task));
    if (this.failure) throw this.failure;
  }
  request(value: unknown, transport: AbortSignal): Promise<DocumentResult> {
    transport.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (++this.attempts > 64)
      throw new AppError("capacity", "本轮文档请求过多，已停止接受新请求。");
    const request = documentRequestSchema.parse(value),
      fingerprint = JSON.stringify(request.operation);
    const previous = this.calls.get(request.callId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError("conflict", "同一文档调用编号不能改变参数。");
      return previous.task;
    }
    if (this.calls.size >= 24)
      throw new AppError("capacity", "本轮文档读取已达 24 次上限。");
    const signal = AbortSignal.any([transport, this.lifetime.signal]);
    const record = this.store.documentOperations.documentBegin(
      this.job,
      request.callId,
      request.operation,
    );
    const task = (async () => {
      if (record.cached) return record.cached;
      try {
        const operation = request.operation;
        let result: DocumentResult;
        if (operation.action === "list")
          result = this.store.documentOperations.documentList(
            this.job,
            operation.after,
          );
        else {
          const file = this.store.documentOperations.documentContent(
            this.job,
            operation.id,
          );
          const read = Object.fromEntries(
            Object.entries(operation).filter(([key]) => key !== "id"),
          );
          let parsed;
          if (
            operation.action === "video.info" ||
            operation.action === "video.frame"
          ) {
            if (file.kind !== "video")
              throw new AppError("invalid_input", "此操作只适用于视频附件。");
            parsed = await this.reader.readVideo(
              file.data,
              file.name,
              videoOperationSchema.parse(read),
              signal,
            );
          } else if (
            operation.action === "info" ||
            operation.action === "text" ||
            operation.action === "render"
          ) {
            if (file.kind !== "pdf")
              throw new AppError(
                "invalid_input",
                "此操作只适用于 PDF，请使用 word 或 table 操作。",
              );
            parsed = await this.reader.read(
              file.data,
              operation.action === "info"
                ? { action: "info" }
                : { action: operation.action, page: operation.page },
              signal,
            );
          } else {
            if (file.kind === "pdf" || file.kind === "video")
              throw new AppError(
                "invalid_input",
                "PDF 请使用 info/text/render；视频请使用 video.info/video.frame。",
              );
            parsed = await this.reader.readOffice(
              file.data,
              file.name,
              file.kind,
              officeReadOperationSchema.parse(read),
              signal,
            );
          }
          result = { ...parsed, id: file.id, name: file.name };
        }
        signal.throwIfAborted();
        this.store.documentOperations.documentComplete(
          this.job,
          record.id,
          result,
        );
        return result;
      } catch (error) {
        try {
          this.store.documentOperations.documentEnd(
            record.id,
            signal.aborted
              ? "读取已取消。原文件仍保留。"
              : error instanceof Error
                ? error.message
                : "文档读取失败。",
            signal.aborted,
          );
        } catch (failure) {
          this.failure = failure;
          this.cancel();
          throw new AppError(
            "unknown",
            "文档读取状态未能保存，请核实应用记录。",
          );
        }
        throw error;
      }
    })();
    this.calls.set(request.callId, { fingerprint, task });
    // The HTTP caller awaits the same task; retain rejection ownership during runtime shutdown.
    void task.catch(() => {});
    return task;
  }
}
