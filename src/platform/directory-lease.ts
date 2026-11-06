import { createServer } from "node:net";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

export class DirectoryLeaseBusy extends Error {
  readonly code = "EADDRINUSE";
  constructor() {
    super("EADDRINUSE：已有进程持有此服务的数据目录。");
  }
}

/**
 * The OS releases the lease on process death; a port is not directory ownership.
 *
 * Windows uses a named pipe; Linux uses an abstract Unix domain socket (the
 * leading NUL means the address has no filesystem path, so nothing needs
 * cleanup on crash — the kernel reclaims it when the listening process dies,
 * matching named-pipe semantics). Other platforms are not supported yet.
 */
export async function ownDirectory(
  directory: string,
  service: "worker" | "supervisor" | "pi-auth" | "daemon-start",
) {
  const address = await leaseAddress(directory, service);
  const server = createServer((socket) => socket.destroy());
  server.maxConnections = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EADDRINUSE"
    )
      throw new DirectoryLeaseBusy();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )),
  };
}

async function leaseAddress(
  directory: string,
  service: "worker" | "supervisor" | "pi-auth" | "daemon-start",
) {
  const key = createHash("sha256")
    .update(
      process.platform === "win32"
        ? (await realpath(directory)).toLowerCase()
        : await realpath(directory),
    )
    .digest("hex");
  if (process.platform === "win32")
    return `\\\\.\\pipe\\aster-independent-${service}-${key}`;
  if (process.platform === "linux")
    return `\0aster-independent-${service}-${key}`;
  throw new Error("当前桌面服务的目录实例锁需要 Windows 或 Linux。");
}
