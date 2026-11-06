import { resolve } from "node:path";
import { startWorker } from "./server.js";
import { DirectoryLeaseBusy } from "../platform/directory-lease.js";
import { workerStartupSchema } from "./startup.js";
import { z } from "zod";

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

const directory = resolve(process.env.ASTER_DATA_DIR ?? ".runtime/aster");
try {
  const worker = await startWorker(
    directory,
    process.env.ASTER_SUPERVISION_ID
      ? { supervisionId: z.uuid().parse(process.env.ASTER_SUPERVISION_ID) }
      : {},
  );
  startup("ready");
  const shutdown = () => {
    void worker.stop().catch((error) => {
      console.error(
        "shutdown failed",
        error instanceof Error ? error.name : "Error",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(
    `aster worker listening on loopback port ${worker.endpoint.port}`,
  );
} catch (error) {
  startup(
    error instanceof DirectoryLeaseBusy ? "contended" : "failed",
    error instanceof Error ? error.message : "后台启动失败。",
  );
  console.error(
    "Worker start failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
