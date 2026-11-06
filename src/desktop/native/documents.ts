import { workerRoutes } from "../../shared/protocol.js";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  officePreviewRequestSchema,
  officeResultSchema,
} from "../../shared/files/office.js";
import { callWorker, readWorker } from "../../worker/client.js";

/** The desktop owns transport lifetimes; parsing stays in the backend's bounded workers. */
export class DesktopDocuments {
  private closing = false;
  private requests = new Map<
    string,
    { controller: AbortController; task: Promise<unknown> }
  >();
  constructor(private readonly directory: string) {}
  request(value: unknown) {
    const input = officePreviewRequestSchema.parse(value);
    if (this.closing) throw new AppError("unavailable", "窗口正在关闭。");
    if (this.requests.has(input.requestId))
      throw new AppError("conflict", "预览请求编号重复。");
    if (this.requests.size >= 2)
      throw new AppError("capacity", "已有两个文档正在处理，请稍后重试。");
    const controller = new AbortController();
    const task = (async () => {
      const endpoint = await readWorker(this.directory);
      controller.signal.throwIfAborted();
      return officeResultSchema.parse(
        await callWorker(
          endpoint,
          workerRoutes.documentsPreview,
          input,
          controller.signal,
        ),
      );
    })().finally(() => this.requests.delete(input.requestId));
    this.requests.set(input.requestId, { controller, task });
    return task;
  }
  cancel(value: unknown) {
    this.requests.get(z.uuid().parse(value))?.controller.abort();
  }
  async close() {
    this.closing = true;
    const entries = [...this.requests.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.task));
  }
}
