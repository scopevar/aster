import { workerRoutes } from "../../shared/protocol.js";
import {
  localWorkspaceRequestSchema,
  localWorkspaceStatusSchema,
} from "../../shared/local-workspace.js";
import { z } from "zod";
import { agentConnectionsRequestSchema } from "../../shared/agent-connections.js";
import {
  avatarAccessSchema,
  avatarContentSchema,
} from "../../shared/avatar.js";
import { querySchema, snapshotUpdateSchema } from "../../shared/snapshot.js";
import {
  memoryScopeSchema,
  memoryViewSchema,
  sharedMemoryScopeSchema,
  sharedMemoryViewSchema,
} from "../../shared/memory.js";
import {
  messageHistoryQuerySchema,
  messageHistoryResultSchema,
  messageSearchQuerySchema,
  messageSearchResultSchema,
} from "../../shared/chat/message-search.js";
import {
  routineQuerySchema,
  routineViewSchema,
} from "../../shared/routines.js";
import {
  skillCatalogQuerySchema,
  skillContentAccessSchema,
  skillSchema,
  skillSummarySchema,
} from "../../shared/tools/skills.js";
import {
  templatesQuerySchema,
  templatesResponseSchema,
} from "../../shared/templates/templates.js";
import {
  toolImageAccessSchema,
  toolImageSchema,
} from "../../shared/tools/tool-calls.js";
import { requestAgentConnections } from "./agent-connections.js";
import type { DesktopHandlerContext } from "./handler-context.js";
import {
  sandboxSettingsRequestSchema,
  sandboxSettingsStatusSchema,
} from "../../shared/tools/sandbox-settings.js";
import { parseInput } from "./ipc-result.js";
import { shell } from "electron";
import { chatGPTAuthRequestSchema } from "../../shared/chatgpt-auth.js";
import { requestChatGPTAuth } from "./chatgpt-auth.js";
import { AppError } from "../../shared/core.js";
export function registerQueryHandlers(
  ctx: Pick<
    DesktopHandlerContext,
    "handle" | "window" | "draining" | "worker" | "workerCall" | "workerFeed"
  >,
) {
  const { handle, worker, workerCall, workerFeed } = ctx;
  let releaseLogin: (() => void) | undefined;
  handle("chatGPTAuth", async (input) => {
    if (ctx.draining) throw new AppError("unavailable", "界面正在退出。");
    const request = parseInput(chatGPTAuthRequestSchema, input);
    if (request.action === "start") {
      const owner = ctx.window;
      if (!owner || owner.isDestroyed())
        throw new AppError("unavailable", "窗口不可用。");
      releaseLogin?.();
      const cancel = () => {
        void worker
          .call(workerRoutes.chatGPTAuth, { action: "cancel", id: request.id })
          .catch(() => {});
      };
      owner.once("closed", cancel);
      releaseLogin = () => owner.removeListener("closed", cancel);
    }
    try {
      const result = await requestChatGPTAuth(worker, request, async (url) => {
        if (ctx.draining || !ctx.window || ctx.window.isDestroyed())
          throw Error("Window closed");
        await shell.openExternal(url);
      });
      if (result.state !== "pending") {
        releaseLogin?.();
        releaseLogin = undefined;
      }
      return result;
    } catch (error) {
      if (request.action === "start") {
        releaseLogin?.();
        releaseLogin = undefined;
      }
      throw error;
    }
  });
  handle("sandboxSettings", async (input) =>
    sandboxSettingsStatusSchema.parse(
      await workerCall(
        workerRoutes.sandboxSettings,
        parseInput(sandboxSettingsRequestSchema, input),
      ),
    ),
  );
  handle("localWorkspace", async (input) =>
    localWorkspaceStatusSchema.parse(
      await worker.call(
        workerRoutes.localWorkspace,
        parseInput(localWorkspaceRequestSchema, input),
        undefined,
        5 * 60_000,
      ),
    ),
  );
  handle("templates", async (input) =>
    templatesResponseSchema.parse(
      await workerCall(
        workerRoutes.templatesQuery,
        parseInput(templatesQuerySchema, input),
      ),
    ),
  );
  handle("snapshot", async (input) =>
    snapshotUpdateSchema.parse(
      await workerCall(workerRoutes.snapshot, parseInput(querySchema, input)),
    ),
  );
  handle("workerStatus", () => workerFeed.status());
  handle("agentConnections", (input) =>
    requestAgentConnections(
      worker,
      parseInput(agentConnectionsRequestSchema, input),
    ),
  );
  handle("messageSearch", async (input) =>
    messageSearchResultSchema.parse(
      await workerCall(
        workerRoutes.messageSearch,
        parseInput(messageSearchQuerySchema, input),
      ),
    ),
  );
  handle("messageHistory", async (input) =>
    messageHistoryResultSchema.parse(
      await workerCall(
        workerRoutes.messageHistory,
        parseInput(messageHistoryQuerySchema, input),
      ),
    ),
  );
  handle("avatarContent", async (input) => {
    const access = parseInput(avatarAccessSchema, input);
    return avatarContentSchema.parse(
      await workerCall(`${workerRoutes.avatar}?${new URLSearchParams(access)}`),
    );
  });
  handle("toolImage", async (input) => {
    const access = parseInput(toolImageAccessSchema, input);
    return toolImageSchema.parse(
      await workerCall(
        `${workerRoutes.toolImage}?${new URLSearchParams(access)}`,
      ),
    );
  });
  handle("routines", async (input) => {
    const query = parseInput(routineQuerySchema, input);
    const params = new URLSearchParams({ botId: query.botId });
    if (query.routineId) params.set("routineId", query.routineId);
    if (query.before) params.set("before", String(query.before));
    return routineViewSchema.parse(
      await workerCall(`${workerRoutes.routines}?${params}`),
    );
  });
  handle("memory", async (input) => {
    const scope = parseInput(memoryScopeSchema, input),
      params = new URLSearchParams({ botId: scope.botId });
    if (scope.conversationId)
      params.set("conversationId", scope.conversationId);
    return memoryViewSchema.parse(
      await workerCall(`${workerRoutes.memory}?${params}`),
    );
  });
  handle("sharedMemory", async (input) => {
    const scope = parseInput(sharedMemoryScopeSchema, input);
    const params = new URLSearchParams(
      scope.kind === "account"
        ? { kind: "account" }
        : { kind: "project", projectId: scope.projectId },
    );
    return sharedMemoryViewSchema.parse(
      await workerCall(`${workerRoutes.memoryShared}?${params}`),
    );
  });
  handle("skillContent", async (input) => {
    const access = parseInput(skillContentAccessSchema, input);
    const params = new URLSearchParams({
      id: access.id,
      botId: access.botId,
      revision: String(access.revision),
    });
    return skillSchema.parse(
      await workerCall(`${workerRoutes.skill}?${params}`),
    );
  });
  handle("skillCatalog", async (input) => {
    const { botIds } = parseInput(skillCatalogQuerySchema, {
      botIds: input,
    });
    const params = new URLSearchParams({ botIds: botIds.join(",") });
    return z
      .array(skillSummarySchema)
      .parse(await workerCall(`${workerRoutes.skillCatalog}?${params}`));
  });
}
