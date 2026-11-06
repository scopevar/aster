import { workerRoutes } from "../shared/protocol.js";
import type { Server } from "node:http";
import type { z } from "zod";
import { processDiagnostics } from "../diagnostics/process.js";
import type { RoutineScheduler } from "../routines/scheduler.js";
import { avatarAccessSchema } from "../shared/avatar.js";
import { AppError } from "../shared/core.js";
import { querySchema, type Snapshot } from "../shared/snapshot.js";
import { workerDiagnosticsSchema } from "../shared/diagnostics.js";
import {
  memoryScopeSchema,
  sharedMemoryScopeSchema,
} from "../shared/memory.js";
import {
  messageHistoryQuerySchema,
  messageSearchQuerySchema,
} from "../shared/chat/message-search.js";
import { routineQuerySchema } from "../shared/routines.js";
import {
  skillCatalogQuerySchema,
  skillContentAccessSchema,
} from "../shared/tools/skills.js";
import { toolImageAccessSchema } from "../shared/tools/tool-calls.js";
import type { WorkerRoute } from "./http-routes.js";
import { jsonRoute, queryRoute, reply } from "./http-routes.js";
type Dependencies = {
  capability: Snapshot["capabilities"];
  scheduler: RoutineScheduler | undefined;
  server: Server;
};
export function queryRoutes(deps: Dependencies): readonly WorkerRoute[] {
  let diagnosticCache:
    | { epoch: string; value: z.infer<typeof workerDiagnosticsSchema> }
    | undefined;
  return [
    queryRoute(
      workerRoutes.diagnostics,
      workerDiagnosticsSchema,
      async (ctx, parse) => {
        if (ctx.url.search)
          throw new AppError("invalid_input", "诊断接口不接受额外参数。");
        const epoch = ctx.store.cursor().epoch;
        if (
          !diagnosticCache ||
          diagnosticCache.epoch !== epoch ||
          Date.now() - diagnosticCache.value.sampledAt >= 5000
        ) {
          const value = parse({
            version: 1,
            sampledAt: Date.now(),
            nodeVersion: process.versions.node,
            process: processDiagnostics(),
            storage: ctx.store.diagnostics(),
            components: {
              agent: deps.capability.agent,
              scheduler: !deps.scheduler
                ? "unavailable"
                : deps.scheduler.error
                  ? "failed"
                  : "ready",
              templates: "ready",
            },
          });
          diagnosticCache = { epoch, value };
        }
        reply(ctx.response, 200, diagnosticCache.value);
      },
    ),
    queryRoute(
      workerRoutes.routines,
      routineQuerySchema,
      async (ctx, parse) => {
        const query = parse({
          ...Object.fromEntries(ctx.url.searchParams),
          ...(ctx.url.searchParams.has("before")
            ? { before: Number(ctx.url.searchParams.get("before")) }
            : {}),
        });
        const address = deps.server.address();
        if (!address || typeof address === "string")
          throw new AppError("unavailable", "后台地址不可用。");
        reply(ctx.response, 200, {
          ...ctx.store.routineOperations.view(query),
          webhookBase: `http://127.0.0.1:${address.port}${workerRoutes.webhooks}`,
          schedulerError: deps.scheduler?.error ?? null,
        });
      },
    ),
    queryRoute(
      workerRoutes.toolImage,
      toolImageAccessSchema,
      async (ctx, parse) => {
        const access = parse(Object.fromEntries(ctx.url.searchParams));
        reply(
          ctx.response,
          200,
          ctx.store.toolOperations.toolImage(access.id, access.conversationId),
        );
      },
    ),
    queryRoute(workerRoutes.memory, memoryScopeSchema, async (ctx, parse) => {
      reply(
        ctx.response,
        200,
        ctx.store.memoryOperations.memoryView(
          parse({
            botId: ctx.url.searchParams.get("botId"),
            conversationId: ctx.url.searchParams.get("conversationId"),
          }),
        ),
      );
    }),
    queryRoute(
      workerRoutes.memoryShared,
      sharedMemoryScopeSchema,
      async (ctx, parse) => {
        const kind = ctx.url.searchParams.get("kind");
        reply(
          ctx.response,
          200,
          ctx.store.memoryOperations.sharedMemoryView(
            parse(
              kind === "project"
                ? { kind, projectId: ctx.url.searchParams.get("projectId") }
                : { kind },
            ),
          ),
        );
      },
    ),
    queryRoute(workerRoutes.avatar, avatarAccessSchema, async (ctx, parse) => {
      const access = parse({
        botId: ctx.url.searchParams.get("botId"),
        hash: ctx.url.searchParams.get("hash"),
      });
      reply(ctx.response, 200, ctx.store.avatarContent(access));
    }),
    queryRoute(
      workerRoutes.skill,
      skillContentAccessSchema,
      async (ctx, parse) => {
        reply(
          ctx.response,
          200,
          ctx.store.skillContent(
            parse({
              id: ctx.url.searchParams.get("id"),
              botId: ctx.url.searchParams.get("botId"),
              revision: Number(ctx.url.searchParams.get("revision")),
            }),
          ),
        );
      },
    ),
    queryRoute(
      workerRoutes.skillCatalog,
      skillCatalogQuerySchema,
      async (ctx, parse) => {
        const query = parse({
          botIds: (ctx.url.searchParams.get("botIds") ?? "").split(","),
        });
        reply(ctx.response, 200, ctx.store.skillCatalog(query.botIds));
      },
    ),
    jsonRoute(workerRoutes.snapshot, querySchema, 4096, async (query, ctx) => {
      const view = ctx.store.snapshotSince(query);
      reply(
        ctx.response,
        200,
        view
          ? {
              changed: true,
              snapshot: {
                ...view,
                capabilities: deps.capability,
              },
            }
          : { changed: false, cursor: ctx.store.cursor() },
      );
    }),
    jsonRoute(
      workerRoutes.messageSearch,
      messageSearchQuerySchema,
      4096,
      async (query, ctx) => {
        reply(ctx.response, 200, ctx.store.views.searchMessages(query));
      },
    ),
    jsonRoute(
      workerRoutes.messageHistory,
      messageHistoryQuerySchema,
      4096,
      async (query, ctx) => {
        reply(ctx.response, 200, ctx.store.views.messageHistory(query));
      },
    ),
  ];
}
