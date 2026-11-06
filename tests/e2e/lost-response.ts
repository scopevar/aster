import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint } from "../../src/platform/endpoint.js";
import { envelopeSchema, type Command } from "../../src/shared/commands.js";

type FaultMode = "drop" | "hold" | "hold-request" | "drop-request" | "reject";

/** Fault injection around the real worker: delay requests or lose committed replies. */
async function interceptCommandResponse(
  directory: string,
  endpoint: Endpoint,
  commandType: Command["type"],
  mode: FaultMode,
  armed = true,
) {
  let dropped = false;
  let held = false;
  const attemptIds: string[] = [];
  let releaseReply: (() => void) | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(holdTimer);
    releaseReply?.();
  };
  const server = createServer((request, response) => {
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    response.once("close", disconnect);
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > 128 * 1024) throw Error("Proxy input limit");
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      const parsed =
        body.length && request.url === "/command"
          ? envelopeSchema.safeParse(JSON.parse(body.toString("utf8")))
          : null;
      if (parsed?.success && parsed.data.command.type === commandType) {
        attemptIds.push(parsed.data.id);
        if (
          armed &&
          ["hold-request", "drop-request", "reject"].includes(mode)
        ) {
          armed = false;
          if (mode === "reject") {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: { code: "capacity", message: "测试队列已满" },
              }),
            );
            return;
          }
          if (mode === "drop-request") {
            dropped = true;
            response.destroy();
            return;
          }
          held = true;
          await new Promise<void>((resolve) => {
            releaseReply = resolve;
            holdTimer = setTimeout(resolve, 10000);
          });
          clearTimeout(holdTimer);
        }
      }
      const headers = new Headers({
        Authorization: `Bearer ${endpoint.token}`,
        Connection: "close",
      });
      for (const name of [
        "content-type",
        "x-attachment-id",
        "x-conversation-id",
        "x-file-name",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetch(
        `http://127.0.0.1:${endpoint.port}${request.url ?? "/"}`,
        {
          method: request.method ?? "GET",
          headers,
          ...(body.length ? { body } : {}),
          signal: AbortSignal.any([
            abort.signal,
            ...(request.url === "/events" ? [] : [AbortSignal.timeout(10000)]),
          ]),
        },
      );
      if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
        response.writeHead(upstream.status, {
          "Content-Type": "text/event-stream",
        });
        if (!upstream.body) throw Error("Missing event stream");
        const reader = upstream.body.getReader();
        const cancel = () => void reader.cancel().catch(() => {});
        response.once("close", cancel);
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done || response.destroyed) break;
            response.write(next.value);
          }
          response.end();
        } finally {
          response.removeListener("close", cancel);
          reader.releaseLock();
        }
        return;
      }
      const result = Buffer.from(await upstream.arrayBuffer());
      if (
        armed &&
        !dropped &&
        !held &&
        upstream.ok &&
        parsed?.success &&
        parsed.data.command.type === commandType
      ) {
        armed = false;
        if (mode === "drop") {
          dropped = true;
          response.destroy();
          return;
        }
        held = true;
        await new Promise<void>((resolve) => {
          releaseReply = resolve;
          holdTimer = setTimeout(resolve, 10000);
        });
        clearTimeout(holdTimer);
      }
      response.writeHead(upstream.status, {
        "Content-Type": "application/json",
      });
      response.end(result);
    })()
      .catch(() => {
        if (!response.destroyed) {
          response.writeHead(502);
          response.end();
        }
      })
      .finally(() => response.removeListener("close", disconnect));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Proxy address missing");
  await writeFile(
    join(directory, "endpoint.json"),
    JSON.stringify({ ...endpoint, port: address.port }),
  );
  return {
    attemptIds,
    get dropped() {
      return dropped;
    },
    get held() {
      return held;
    },
    release,
    arm(nextType: Command["type"], nextMode: FaultMode) {
      release();
      commandType = nextType;
      mode = nextMode;
      dropped = false;
      held = false;
      armed = true;
      attemptIds.length = 0;
    },
    async close() {
      release();
      await writeFile(
        join(directory, "endpoint.json"),
        JSON.stringify(endpoint),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function loseGroupStartResponse(
  directory: string,
  endpoint: Endpoint,
  commandType: Command["type"] = "group.start",
) {
  return interceptCommandResponse(directory, endpoint, commandType, "drop");
}

/** Holds one real committed reply until released, with a bounded failure deadline. */
export function holdCommandResponse(
  directory: string,
  endpoint: Endpoint,
  commandType: Command["type"],
) {
  return interceptCommandResponse(directory, endpoint, commandType, "hold");
}

/** Install before Electron starts: its endpoint cache must point at the proxy for every fault. */
export function commandResponseFaults(directory: string, endpoint: Endpoint) {
  return interceptCommandResponse(
    directory,
    endpoint,
    "skills.select",
    "hold",
    false,
  );
}
