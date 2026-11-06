import { spawn } from "node:child_process";

/** A dev command owns its child until exit, including graceful cancellation. */
export function runNode(root, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    const stop = () => child.kill("SIGTERM");
    const cleanup = () => signal?.removeEventListener("abort", stop);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, killedBy) => {
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (killedBy) console.error(`命令被 ${killedBy} 终止。`);
      resolve(code ?? 1);
    });
  });
}
