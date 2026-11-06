import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AppError } from "../shared/core.js";
import {
  sandboxLimits,
  sandboxOutputSchema,
  type SandboxLaunch,
  type SandboxPreparation,
} from "./protocol.js";
import type { ScriptExecution } from "../shared/tools/scripts.js";
import type { z } from "zod";

type Output = z.infer<typeof sandboxOutputSchema>;
type Pending = {
  type: Output["type"];
  accept(value: Output): void;
  reject(error: Error): void;
};
const exec = promisify(execFile);

/** The SDK and its VM are descendants of this owned process, with no daemon secrets. */
export class SandboxProcess {
  private child: ChildProcess | undefined;
  private readonly pending = new Set<Pending>();
  private failure: Error | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private exit: Promise<void> = Promise.resolve();
  private exited = false;
  private readonly cancelled: () => void;
  constructor(
    private readonly signal: AbortSignal,
    private readonly status: (detail: string) => void,
  ) {
    this.cancelled = () => {
      void this.close().catch(() => {});
    };
  }
  private async start(home: string) {
    this.signal.throwIfAborted();
    let entry = fileURLToPath(new URL("./worker.js", import.meta.url));
    try {
      await access(entry);
    } catch {
      entry = fileURLToPath(
        new URL("../../dist/sandbox/worker.js", import.meta.url),
      );
      await access(entry);
    }
    this.signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = { MSB_HOME: home };
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"])
      if (process.env[name]) env[name] = process.env[name];
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(process.execPath, [entry], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const fail = (error: Error) => {
      this.failure ??= error;
      // Creation cancellation can report an SDK error before the helper confirms
      // destruction. Keep waiting for that confirmation rather than killing early.
      for (const waiter of this.pending)
        if (waiter.type !== "closed") waiter.reject(error);
    };
    child.once("error", () =>
      fail(new AppError("unavailable", "无法启动 Microsandbox SDK 进程。")),
    );
    child.stdin.on("error", () =>
      fail(
        new AppError("unknown", "Microsandbox 控制通道中断；请核实工作文件。"),
      ),
    );
    // Diagnostic bytes are bounded and never returned as a successful execution result.
    let diagnostics = 0;
    child.stderr.on("data", (data: Buffer) => {
      diagnostics += data.length;
      if (diagnostics > 65536) {
        fail(new AppError("unavailable", "Microsandbox 初始化诊断超过上限。"));
        void this.close().catch(() => {});
      }
    });
    lines.on("line", (line) => {
      try {
        if (Buffer.byteLength(line) > 1024 * 1024)
          throw new Error("response size");
        const output = sandboxOutputSchema.parse(JSON.parse(line));
        if (output.type === "status") {
          this.status(output.detail);
          return;
        }
        if (output.type === "error") {
          fail(new AppError("unavailable", output.detail));
          return;
        }
        if (output.type === "closed") this.closed = true;
        for (const waiter of this.pending)
          if (waiter.type === output.type) waiter.accept(output);
      } catch {
        fail(
          new AppError(
            "unknown",
            "Microsandbox 返回无效响应，未确认执行结果。",
          ),
        );
        void this.close().catch(() => {});
      }
    });
    this.exit = new Promise((resolve) =>
      child.once("close", () => {
        this.exited = true;
        lines.close();
        if (!this.closed)
          fail(
            new AppError("unknown", "Microsandbox 意外退出，清理结果未确认。"),
          );
        resolve();
      }),
    );
    this.signal.addEventListener("abort", this.cancelled, { once: true });
  }
  async prepare(config: SandboxPreparation) {
    await this.start(config.home);
    const prepared = this.wait("prepared", sandboxLimits.preparationMs);
    this.child?.stdin?.write(
      `${JSON.stringify({ type: "prepare", config })}\n`,
    );
    if (this.signal.aborted) this.cancelled();
    try {
      await prepared;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async open(config: SandboxLaunch) {
    await this.start(config.home);
    const ready = this.wait("ready", sandboxLimits.startupMs);
    this.child?.stdin?.write(`${JSON.stringify({ type: "open", config })}\n`);
    if (this.signal.aborted) this.cancelled();
    try {
      await ready;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private wait(
    type: "prepared" | "ready" | "result" | "closed",
    timeout: number,
    ignoreFailure = false,
  ) {
    if (this.failure && !ignoreFailure) return Promise.reject(this.failure);
    return new Promise<Output>((accept, reject) => {
      const timer = setTimeout(
        () =>
          waiter.reject(
            new AppError(
              "unavailable",
              {
                prepared:
                  "脚本环境资源准备超时，已保留下载进度，可重试；脚本尚未执行。",
                ready: "Microsandbox 虚拟机启动超时，脚本尚未执行。",
                result: "Microsandbox 脚本执行通道等待超时，未确认执行结果。",
                closed: "Microsandbox 清理确认超时，未确认资源已释放。",
              }[type],
            ),
          ),
        timeout,
      );
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(waiter);
      };
      const waiter: Pending = {
        type,
        accept: (value) => {
          finish();
          accept(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      this.pending.add(waiter);
    });
  }
  async execute(command: string): Promise<ScriptExecution> {
    this.signal.throwIfAborted();
    if (this.closing) throw new AppError("unavailable", "脚本环境正在停止。");
    const result = this.wait("result", sandboxLimits.commandMs + 15000);
    this.child?.stdin?.write(`${JSON.stringify({ type: "exec", command })}\n`);
    try {
      const output = await result;
      if (output.type !== "result")
        throw new AppError("unknown", "脚本结果不匹配。");
      return output.result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close() {
    return (this.closing ??= (async () => {
      this.signal.removeEventListener("abort", this.cancelled);
      if (!this.child) return;
      for (const waiter of this.pending)
        if (waiter.type !== "closed")
          waiter.reject(
            this.signal.aborted
              ? new DOMException("Script cancelled", "AbortError")
              : (this.failure ??
                  new AppError("unavailable", "脚本环境正在停止。")),
          );
      if (!this.exited && !this.closed) {
        const confirmation = this.wait("closed", 15000, true);
        this.child.stdin?.write(`${JSON.stringify({ type: "close" })}\n`);
        try {
          await confirmation;
        } catch (error) {
          await this.killTree();
          if (!(await this.exitedWithin(5000)))
            throw new AppError(
              "unknown",
              "Microsandbox 所属进程树停止超时，清理未确认。",
            );
          throw new AppError(
            "unknown",
            `Microsandbox 清理未确认；已终止所属进程树，请保留诊断。${error instanceof Error ? error.message : ""}`,
          );
        }
      }
      // Even an acknowledged destroy must release the native handles and helper process.
      if (!(await this.exitedWithin(5000))) {
        await this.killTree();
        if (!(await this.exitedWithin(5000)))
          throw new AppError(
            "unknown",
            "Microsandbox SDK 进程未停止，清理未确认。",
          );
        throw new AppError(
          "unknown",
          "虚拟机已销毁，但 SDK 进程未释放句柄，已强制终止所属进程树；请保留诊断。",
        );
      }
      if (!this.closed)
        throw this.failure ?? new AppError("unknown", "沙箱清理未确认。");
    })());
  }
  private exitedWithin(timeout: number) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      void this.exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  private async killTree() {
    if (!this.child?.pid || this.exited) return;
    if (process.platform === "win32") {
      try {
        await exec(
          "taskkill.exe",
          ["/PID", String(this.child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
        );
      } catch (error) {
        if (!this.exited) throw error;
      }
    } else {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch (error) {
        if (!this.exited) throw error;
      }
    }
  }
}
