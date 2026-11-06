import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`${command} 执行失败：${output.trim()}`);
  }
}

/** 使用参数数组；密钥只通过 env 传递。取消时终止整个构建进程组。 */
export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const cancel = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          reject(error);
      }
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", cancel);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("发布已取消。"));
      else if (code !== 0)
        reject(
          new CommandError(command, stderr || `退出码 ${code}，信号 ${signal}`),
        );
      else resolve(stdout.trim());
    });
  });
}
