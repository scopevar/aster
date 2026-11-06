import { spawn } from "node:child_process";

/** The desktop must use Electron's GUI entry point, even in a Node-mode parent. */
export async function runDesktop(
  executable: string,
  root: string,
  directory: string,
): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASTER_DATA_DIR: directory,
  };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  const child = spawn(executable, [root], {
    stdio: "inherit",
    windowsHide: false,
    env,
  });
  return new Promise<number>((resolve, reject) => {
    let requested: "SIGINT" | "SIGTERM" | undefined;
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (requested) return;
      requested = signal;
      console.info("Aster：正在正常退出桌面。");
      child.kill("SIGTERM");
    };
    const interrupt = () => stop("SIGINT"),
      terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (requested) {
        console.info("Aster 桌面已退出。");
        resolve(requested === "SIGINT" ? 130 : 143);
        return;
      }
      if (signal) console.error(`Aster 桌面进程被信号 ${signal} 终止。`);
      else if (code !== 0)
        console.error(
          `Aster 桌面进程启动或运行失败（退出码 ${code ?? "未知"}）。`,
        );
      else console.info("Aster 桌面进程已退出（退出码 0）。");
      if (signal || code !== 0)
        console.error(
          "请查看上方 Electron 错误，并执行 pnpm dev --doctor 检查环境。",
        );
      resolve(code ?? 1);
    });
  });
}
