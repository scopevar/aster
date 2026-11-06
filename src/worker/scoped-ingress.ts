import { workerRoutes } from "../shared/protocol.js";
import type { WorkerPath } from "../shared/protocol.js";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Runtime } from "../chat/runtime.js";
import { AppError } from "../shared/core.js";
import { webhookInputSchema } from "../shared/routines.js";
import type { Store } from "../storage/store.js";
import type { ToolService } from "../tools/service.js";
import type { WakeTopic } from "./http-routes.js";
import { readJson, reply } from "./http-routes.js";
const webhookPattern = new RegExp(
  `^${workerRoutes.webhooks}/([a-f0-9-]{36})(?:/events/([a-f0-9-]{36}))?$`,
);
type ToolRoute = {
  path: WorkerPath;
  bodyLimit: number | undefined;
  notify: "routineTool" | undefined;
  invoke: (
    service: ToolService,
    token: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
};
export function createScopedIngress(ctx: {
  readonly closing: boolean;
  readonly updatePreparing?: boolean;
  readonly store: Store | undefined;
  readonly runtime: Runtime | undefined;
  readonly tools: ToolService | undefined;
  notify(topic: WakeTopic): void;
}) {
  let webhookWindow = 0,
    webhookRequests = 0;
  const toolRoutes: readonly ToolRoute[] = [
    {
      path: workerRoutes.toolsRead,
      bodyLimit: 8192,
      notify: undefined,
      invoke: (service, token, input, signal) =>
        service.read(token, input, signal),
    },
    {
      path: workerRoutes.toolsArtifacts,
      bodyLimit: 40 * 1024,
      notify: undefined,
      invoke: (service, token, input, signal) =>
        service.artifacts(token, input, signal),
    },
    {
      path: workerRoutes.toolsScripts,
      bodyLimit: 256 * 1024,
      notify: undefined,
      invoke: (service, token, input, signal) =>
        service.scripts(token, input, signal),
    },
    {
      path: workerRoutes.toolsPlugins,
      bodyLimit: 256 * 1024,
      notify: undefined,
      invoke: (service, token, input, signal) =>
        service.plugins(token, input, signal),
    },
    {
      path: workerRoutes.toolsHistory,
      bodyLimit: 8192,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.history(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsFiles,
      bodyLimit: 4 * 1024 * 1024,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.files(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsTemplates,
      bodyLimit: 64 * 1024,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.templates(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsRoutines,
      bodyLimit: undefined,
      notify: "routineTool",
      invoke: (service, scopedToken, input, signal) =>
        service.routines(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsNotify,
      bodyLimit: 16 * 1024,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.notify(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsDocuments,
      bodyLimit: undefined,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.documents(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsSkills,
      bodyLimit: undefined,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.skills(scopedToken, input, signal),
    },
    {
      path: workerRoutes.toolsQuestion,
      bodyLimit: undefined,
      notify: undefined,
      invoke: (service, scopedToken, input, signal) =>
        service.question(scopedToken, input, signal),
    },
  ];
  {
    const seen = new Set<string>();
    for (const route of toolRoutes) {
      if (seen.has(route.path))
        throw new Error(`重复的工具路由：${route.path}`);
      seen.add(route.path);
    }
  }
  const handleWebhook = async (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => {
    const hook = webhookPattern.exec((request.url ?? "").split("?")[0] ?? "");
    if (!hook) return false;
    if (ctx.closing || !ctx.store || !ctx.runtime || request.headers.origin)
      throw new AppError("unauthorized", "Webhook 不可访问。");
    const activeStore = ctx.store;
    const now = Date.now();
    if (now - webhookWindow >= 60000) {
      webhookWindow = now;
      webhookRequests = 0;
    }
    if (++webhookRequests > 120) {
      reply(response, 429, {
        error: {
          code: "capacity",
          message: "Webhook 入口请求过于频繁，请稍后重试。",
        },
      });
      return true;
    }
    const id = z.uuid().parse(hook[1]);
    const key =
      /^Bearer ([a-f0-9]{64})$/.exec(
        request.headers.authorization ?? "",
      )?.[1] ?? "";
    if (request.method === "GET" && hook[2]) {
      reply(
        response,
        200,
        activeStore.routineOperations.webhookEvent(
          id,
          key,
          z.uuid().parse(hook[2]),
        ),
      );
    } else if (request.method === "POST" && !hook[2]) {
      const input = webhookInputSchema.parse(
        await readJson(request, 40 * 1024, signal),
      );
      // Authentication, state, deduplication and enqueue are checked together after the body arrives.
      if (ctx.updatePreparing)
        throw new AppError(
          "unavailable",
          "正在准备更新，Webhook 未接受，请稍后重试。",
        );
      const event = activeStore.routineOperations.acceptWebhook(id, key, input);
      ctx.notify("webhook");
      reply(response, 202, { accepted: true, event });
    } else throw new AppError("not_found", "未知 Webhook 操作。");
    return true;
  };
  const handleTools = async (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => {
    if (request.method !== "POST") return false;
    const route = toolRoutes.find((item) => request.url === item.path);
    if (!route) return false;
    if (ctx.closing || !ctx.tools || request.headers.origin)
      throw new AppError("unauthorized", "工具运行接口不可访问。");
    const service = ctx.tools;
    const scopedToken =
      /^Bearer ([a-f0-9]{64})$/.exec(
        request.headers.authorization ?? "",
      )?.[1] ?? "";
    const controller = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", disconnected);
    try {
      const output = await route.invoke(
        service,
        scopedToken,
        await readJson(request, route.bodyLimit, signal),
        AbortSignal.any([controller.signal, signal]),
      );
      reply(response, 200, output);
      if (route.notify) ctx.notify(route.notify);
    } finally {
      response.removeListener("close", disconnected);
    }
    return true;
  };
  return { handleWebhook, handleTools };
}
