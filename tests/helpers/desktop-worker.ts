import { randomUUID } from "node:crypto";
import { startWorker } from "../../src/worker/server.js";

/** An explicitly owned execution daemon for Electron tests that inject an Agent or resource boundary. */
export function startDesktopWorker(
  directory: string,
  options: Parameters<typeof startWorker>[1] = {},
) {
  return startWorker(directory, {
    ...options,
    daemon: { instanceId: randomUUID() },
  });
}
