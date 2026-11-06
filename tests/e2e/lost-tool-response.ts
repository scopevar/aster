import { createServer } from "node:http";
import type { AgentInput } from "../../src/chat/agent.js";
import { skillToolRequestSchema } from "../../src/shared/tools/skill-tools.js";

/** Real MCP HTTP requests reach the real worker; only one committed response is dropped. */
export async function loseSkillCreateResponse(
  access: NonNullable<AgentInput["toolAccess"]>,
) {
  let dropped = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > 128 * 1024) throw Error("Proxy request limit");
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      const parsed = skillToolRequestSchema.safeParse(
        body.length ? JSON.parse(body.toString("utf8")) : null,
      );
      const upstream = await fetch(
        `http://127.0.0.1:${access.port}${request.url ?? "/"}`,
        {
          method: request.method ?? "POST",
          headers: {
            Authorization: `Bearer ${access.token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(30000),
        },
      );
      const result = await upstream.text();
      if (
        !dropped &&
        request.url === "/tools/skills" &&
        upstream.ok &&
        parsed.success &&
        parsed.data.operation.action === "create"
      ) {
        dropped = true;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        "Content-Type": "application/json",
      });
      response.end(result);
    })().catch(() => {
      if (!response.destroyed) {
        response.writeHead(502);
        response.end();
      }
    });
  });
  server.requestTimeout = 35000;
  server.maxConnections = 8;
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
  return {
    access: { ...access, port: address.port },
    get dropped() {
      return dropped;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
