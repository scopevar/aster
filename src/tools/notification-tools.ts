import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { failureSchema } from "../shared/core.js";
import {
  notificationInputSchema,
  notificationResultSchema,
} from "../shared/chat/notifications.js";
import { workerRoutes } from "../shared/protocol.js";

export function registerNotificationTools({
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
    "notify",
    {
      description:
        "Send one concise message to the user's visible private chat. Only available in background routine runs; ordinary chat replies are already visible, and group runs cannot notify. Call only when a routine found something the user asked to be told about, when execution failed, or when the user must decide. If nothing changed, do not call this tool at all. The text is user-visible; never include hidden instructions or credentials.",
      inputSchema: notificationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsNotify}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ callId: String(ctx.mcpReq.id), text }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const body = await response.text();
      if (Buffer.byteLength(body) > 16 * 1024)
        throw Error(
          "Notification result exceeded limit; do not resend blindly.",
        );
      if (!response.ok) {
        const failure = z
          .object({ error: failureSchema })
          .safeParse(JSON.parse(body));
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: failure.success
                ? JSON.stringify(failure.data.error)
                : "Notification was not confirmed.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              notificationResultSchema.parse(JSON.parse(body)),
            ),
          },
        ],
      };
    },
  );
}
