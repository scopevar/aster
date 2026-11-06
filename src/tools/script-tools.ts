import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { workerRoutes } from "../shared/protocol.js";
import {
  scriptActionSchema,
  scriptResultSchema,
  scriptToolTimeoutMs,
} from "../shared/tools/scripts.js";
import { failureSchema } from "../shared/core.js";

export function registerShellTool({
  server,
  port,
  token,
  shutdown,
}: {
  server: McpServer;
  port: number;
  token: string;
  shutdown: AbortController;
}) {
  server.registerTool(
    "shell",
    {
      description:
        "Execute Bash commands, Python 3.12 and Node 22 in THIS Bot's Microsandbox Linux VM. Use Python for documents: pypdfium2 (PDF text/render), python-docx (Word), openpyxl/xlrd (Excel), Pillow (images), av (video). Standard csv handles CSV/TSV. Read /inputs to discover this round's read-only attachments. Write scripts and generated files under persistent /workspace; stdout/stderr text is returned directly. Use read to inspect generated images. Deliver files with [name](sandbox:/workspace/path) in your final reply; no export call is needed. Submit each exact command once: when enabled, Jev reviews it first and approves clear low-risk tasks automatically; otherwise the application asks the user to approve. Do not ask the user to approve separately in chat or claim approval yourself. Commands run sequentially, max 60 seconds, 512 MiB RAM; stdout/stderr each max 64 KiB. Default network is disabled; if requested, network permits at most four exact public DNS hosts via HTTPS/443 for this round. Keep the same network list after the first approved command. No host filesystem, credentials, desktop or browser. Never retry unknown effects. Cancellation/timeout destroys the VM; work files persist.",
      inputSchema: scriptActionSchema.omit({ type: true }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsScripts}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            callId: String(ctx.mcpReq.id),
            operation: { action: "exec", ...input },
          }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(scriptToolTimeoutMs),
          ]),
        },
      );
      if (!response.body) throw new Error("Script response is empty.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024)
            throw new Error("Script response exceeded its limit.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return response.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(scriptResultSchema.parse(value)),
              },
            ],
          }
        : {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  z.object({ error: failureSchema }).parse(value).error,
                ),
              },
            ],
          };
    },
  );
}
