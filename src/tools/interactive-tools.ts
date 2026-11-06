import { workerRoutes } from "../shared/protocol.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { questionInputSchema } from "../shared/chat/questions.js";
export function registerInteractiveTools({
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
    "ask_user",
    {
      description:
        'Present one structured question with 2–6 distinct answer options and a custom answer field. Input is exactly {"prompt":"question text","options":["first choice","second choice"]}; do not send a questions array, headers, or option objects. Use only when user input is needed or explicitly requested. Returns after the card is saved, not after an answer. Input validation failure saves no card; correct the input before trying again, but never retry an unknown result. Continue independent work or finish this turn; a later explicit user answer arrives as a new message in this conversation. Never infer an answer or treat a choice as tool authorization.',
      inputSchema: questionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (question, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsQuestion}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ callId: String(ctx.mcpReq.id), question }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      if (!response.ok)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Question was not confirmed. Inspect the application status; do not claim the user answered.",
            },
          ],
        };
      const result = z
        .object({
          id: z.uuid(),
          status: z.enum(["pending", "answered", "skipped", "cancelled"]),
        })
        .strict()
        .parse(await response.json());
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...result,
              detail:
                "Question saved. No answer is implied. A later user answer will arrive as a separate message.",
            }),
          },
        ],
      };
    },
  );
}
