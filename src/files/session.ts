import { randomUUID } from "node:crypto";
import type { DocumentReader } from "../documents/reader.js";
import { AppError } from "../shared/core.js";
import {
  fileRequestSchema,
  fileResultSchema,
  type FileResult,
} from "../shared/files/files.js";
import type { Job, Store } from "../storage/store.js";
import { readGrantedDocument } from "./documents.js";
import { readGrantedPath } from "./read.js";

/** One runtime tool scope owns requests, cancellation and handle drain. */
export class FileSession {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<FileResult>>();
  private readonly reading = new Map<AbortController, string>();
  private attempts = 0;
  constructor(
    private readonly store: Pick<Store, "files">,
    private readonly job: Job,
    private readonly scopeId = randomUUID(),
    private readonly reader?: DocumentReader,
  ) {}
  request(value: unknown, transportSignal: AbortSignal) {
    const request = fileRequestSchema.parse(value);
    const access = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      transportSignal,
      access.signal,
    ]);
    signal.throwIfAborted();
    if (++this.attempts > 64 || this.pending.size >= 2)
      throw new AppError(
        "capacity",
        "文件工具本回合最多 64 次请求，同时最多两个读取。",
      );
    if ("grantId" in request.operation)
      this.reading.set(access, request.operation.grantId);
    const operation = (async (): Promise<FileResult> => {
      this.store.files.requireFileRun(this.job);
      const input = request.operation;
      if (input.action === "grants")
        return {
          action: "grants",
          grants: this.store.files.directoryGrants(this.job.conversationId),
        };
      if (input.action === "save")
        return {
          action: "save",
          attachment: this.store.files.saveFileTool(
            this.job,
            `${this.scopeId}:${request.callId}`,
            input,
          ),
        };
      const root = this.store.files.fileGrantRoot(this.job, input.grantId);
      try {
        let result: FileResult;
        if (input.action === "document") {
          if (!this.reader)
            throw new AppError("unavailable", "文档解析服务未就绪。");
          result = await readGrantedDocument(this.reader, root, input, signal);
        } else result = await readGrantedPath(root, input, signal);
        signal.throwIfAborted();
        this.store.files.fileGrantRoot(this.job, input.grantId);
        return fileResultSchema.parse(result);
      } catch (error) {
        if (error instanceof AppError || signal.aborted) throw error;
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          throw new AppError("not_found", "授权目录或文件已不存在。");
        throw new AppError(
          "unavailable",
          "文件读取失败，请检查目录权限或重新授权。",
        );
      }
    })();
    this.pending.add(operation);
    void operation
      .finally(() => {
        this.pending.delete(operation);
        this.reading.delete(access);
      })
      .catch(() => {});
    return operation;
  }
  cancel() {
    this.controller.abort();
  }
  refreshGrants() {
    for (const [controller, grantId] of this.reading) {
      try {
        this.store.files.fileGrantRoot(this.job, grantId);
      } catch (error) {
        controller.abort(
          error instanceof AppError
            ? error
            : new AppError("unavailable", "无法确认目录授权，读取已停止。"),
        );
      }
    }
  }
  async close() {
    this.cancel();
    await Promise.allSettled([...this.pending]);
  }
}
