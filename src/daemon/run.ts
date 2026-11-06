import { randomUUID } from "node:crypto";
import { startWorker } from "../worker/server.js";
import { defaultSecretBox } from "../security/secret.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Console } from "node:console";

export async function runDaemon(directory: string) {
  process.env.ASTER_STRICT_SECRETS = "1";
  await mkdir(directory, { recursive: true });
  if (process.env.ASTER_DAEMON_BACKGROUND === "1") {
    const log = createWriteStream(join(directory, "daemon.log"), {
      flags: "a",
      mode: 0o600,
    });
    log.on("error", () => {
      process.exitCode = 1;
    });
    globalThis.console = new Console(log, log);
  }
  const secretBox = defaultSecretBox(directory);
  const instanceId = randomUUID();
  const worker = await startWorker(directory, {
    daemon: { instanceId },
    secretBox,
    onStopped: () => setImmediate(() => process.exit(0)),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= worker.stop());
  const signalStop = () =>
    void stop().catch(() => {
      process.exitCode = 1;
    });
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  // The HTTP stop path uses this same drain. The receipt is written by startWorker
  // only after service cleanup and before releasing the lifetime lease.
  console.info(
    `daemon ready (pid ${process.pid}, port ${worker.endpoint.port})`,
  );
  return worker;
}
