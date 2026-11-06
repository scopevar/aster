import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DirectoryLeaseBusy } from "../platform/directory-lease.js";
import { workerStartupSchema } from "./startup.js";
import { superviseWorker } from "./supervisor.js";

function startup(state: "ready" | "contended" | "failed", message = "") {
  if (process.send && process.connected)
    process.send(
      workerStartupSchema.parse({
        kind: "worker-startup",
        state,
        message: message.slice(0, 1000),
      }),
      undefined,
      undefined,
      () => {
        if (process.connected) process.disconnect();
      },
    );
}
const signal = new AbortController();
process.once("SIGINT", () => signal.abort());
process.once("SIGTERM", () => signal.abort());
try {
  await superviseWorker(
    resolve(process.env.ASTER_DATA_DIR ?? ".runtime/aster"),
    fileURLToPath(new URL("./main.js", import.meta.url)),
    () => startup("ready"),
    signal.signal,
  );
} catch (error) {
  startup(
    error instanceof DirectoryLeaseBusy ? "contended" : "failed",
    error instanceof Error ? error.message : "后台守护启动失败。",
  );
  console.error(
    "worker supervisor stopped",
    error instanceof Error ? error.name : "Error",
  );
  process.exitCode = error instanceof DirectoryLeaseBusy ? 0 : 1;
}
