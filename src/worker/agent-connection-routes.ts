import { workerRoutes } from "../shared/protocol.js";
import type { AgentConnections } from "../agent/connections.js";
import { agentConnectionsRequestSchema } from "../shared/agent-connections.js";
import { controlJsonRoute, jsonRoute, reply } from "./http-routes.js";
import { chatGPTAuthRequestSchema } from "../shared/chatgpt-auth.js";
import { AppError } from "../shared/core.js";

export function agentConnectionRoutes(connections: AgentConnections) {
  return [
    controlJsonRoute(
      workerRoutes.chatGPTAuth,
      chatGPTAuthRequestSchema,
      1024,
      async (request, ctx) => {
        reply(
          ctx.response,
          200,
          await connections.chatGPTAuth(request, ctx.signal),
        );
      },
    ),
    jsonRoute(
      workerRoutes.agentConnections,
      agentConnectionsRequestSchema,
      1024 * 1024,
      async (request, ctx) => {
        if (
          request.action === "assign" &&
          !ctx.store
            .snapshotSince({})
            ?.bots.some(
              (bot) => bot.id === request.botId && bot.lifecycle === "active",
            )
        )
          throw new AppError("not_found", "Bot 已不存在或不属于当前账户。");
        reply(
          ctx.response,
          200,
          await connections.request(request, ctx.signal),
        );
      },
    ),
  ];
}
