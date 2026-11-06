import { workerRoutes } from "../../shared/protocol.js";
import { basename } from "node:path";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  diagnosticsRequestSchema,
  diagnosticsSchema,
  workerDiagnosticsSchema,
  type Diagnostics,
  type DiagnosticsResult,
} from "../../shared/diagnostics.js";
import { readWorker } from "../../worker/client.js";
import { processDiagnostics } from "../../diagnostics/process.js";
import { saveDiagnostics } from "../../diagnostics/save.js";
import { readSupervisionDiagnostics } from "../../diagnostics/supervision.js";

type DesktopVersion = Pick<
  Diagnostics,
  "appVersion" | "nodeVersion" | "electronVersion" | "platform" | "architecture"
>;
export class DesktopDiagnostics {
  private active:
    | {
        id: string;
        controller: AbortController;
        task: Promise<DiagnosticsResult>;
      }
    | undefined;
  private closing = false;
  constructor(
    private readonly directory: string,
    private readonly version: DesktopVersion,
  ) {}
  request(
    raw: unknown,
    chooseFile?: () => Promise<string | null>,
  ): Promise<DiagnosticsResult> {
    const input = diagnosticsRequestSchema.parse(raw);
    if (this.closing) throw new AppError("unavailable", "诊断服务正在关闭。");
    if (this.active)
      throw new AppError(
        "capacity",
        "已有诊断采集或保存操作，请完成或取消后再试。",
      );
    const controller = new AbortController();
    const task = (async (): Promise<DiagnosticsResult> => {
      const report = await this.collect(controller.signal);
      controller.signal.throwIfAborted();
      if (input.action === "inspect") return { status: "inspected", report };
      if (!chooseFile)
        throw new AppError("unavailable", "原生保存窗口不可用。");
      const path = await chooseFile();
      controller.signal.throwIfAborted();
      if (!path) return { status: "cancelled" };
      await saveDiagnostics(path, report, controller.signal);
      return { status: "saved", report, name: basename(path) };
    })()
      .catch((error: unknown) => {
        if (controller.signal.aborted) return { status: "cancelled" as const };
        throw error;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { id: input.requestId, controller, task };
    return task;
  }
  cancel(id: unknown) {
    if (this.active?.id === z.uuid().parse(id)) this.active.controller.abort();
  }
  async close() {
    this.closing = true;
    this.active?.controller.abort();
    await Promise.allSettled(this.active ? [this.active.task] : []);
  }
  private async collect(signal: AbortSignal): Promise<Diagnostics> {
    let worker: Diagnostics["worker"];
    const timeout = AbortSignal.timeout(5000);
    const sampling = AbortSignal.any([signal, timeout]);
    try {
      const endpoint = await readWorker(this.directory, sampling);
      const response = await fetch(
        `http://127.0.0.1:${endpoint.port}${workerRoutes.diagnostics}`,
        {
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            Connection: "close",
          },
          signal: sampling,
          redirect: "error",
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AppError("unavailable", "诊断接口不可用。");
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 128 * 1024) throw new Error("diagnostic response limit");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const data = workerDiagnosticsSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      worker = { available: true, data };
    } catch (error) {
      signal.throwIfAborted();
      worker = {
        available: false,
        reason:
          error instanceof z.ZodError || error instanceof SyntaxError
            ? "invalid_response"
            : "unreachable",
      };
    }
    return diagnosticsSchema.parse({
      version: 1,
      scope: "desktop-main-and-worker",
      sampledAt: Date.now(),
      ...this.version,
      process: processDiagnostics(),
      worker,
      supervision: await readSupervisionDiagnostics(this.directory, signal),
    });
  }
}
