import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ZodError } from "zod";
import type { Runtime } from "../chat/runtime.js";
import { AppError } from "../shared/core.js";
import { workerRoutes } from "../shared/protocol.js";
import { scriptToolTimeoutMs } from "../shared/tools/scripts.js";
import type { Store } from "../storage/store.js";
import { type DataSession } from "./data-session.js";
import type { HttpContext, WorkerRoute } from "./http-routes.js";
import { reply, routeMatches } from "./http-routes.js";
import type { createScopedIngress } from "./scoped-ingress.js";
import type { SessionRequests } from "./session-requests.js";
type Context = ReturnType<typeof createScopedIngress> & {
  token: string;
  closing: boolean;
  changingAccount: boolean;
  store: Store | undefined;
  runtime: Runtime | undefined;
  routes: readonly WorkerRoute[];
  controlRequests: SessionRequests;
  dataSession: DataSession | undefined;
};
/** Authenticates and dispatches requests within their owning account's cancellation scope. */
export function createWorkerHttpServer(context: Context) {
  const authenticate = (request: IncomingMessage) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${context.token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new AppError("unauthorized", "连接认证失败。");
    if (request.headers.origin)
      throw new AppError("unauthorized", "浏览器来源不可直接访问后台。");
  };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => {
    if (await context.handleWebhook(request, response, signal)) return;
    if (await context.handleTools(request, response, signal)) return;
    authenticate(request);
    if (context.closing) throw new AppError("unavailable", "后台正在关闭。");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    signal.throwIfAborted();
    const ctx: HttpContext = {
      request,
      response,
      url,
      signal,
    };
    const route = context.routes.find((item) =>
      routeMatches(item, request.method, url.pathname),
    );
    if (!route) throw new AppError("not_found", "未知的后台接口。");
    if (route.scope === "control") await route.run(ctx);
    else {
      if (!context.store || !context.runtime)
        throw new AppError("unavailable", "本地工作区尚未挂载。");
      await route.run({
        ...ctx,
        store: context.store,
        runtime: context.runtime,
      });
    }
  };
  const server = createServer((request, response) => {
    const dispatch = async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        context.routes.some(
          (route) =>
            route.scope === "control" &&
            routeMatches(route, request.method, url.pathname),
        )
      )
        return context.controlRequests.run(
          request,
          response,
          (signal) => handle(request, response, signal),
          url.pathname === workerRoutes.localWorkspace ? 5 * 60_000 : 35_000,
        );
      const mounted = context.dataSession;
      if (context.closing || context.changingAccount || !mounted)
        throw new AppError("unavailable", "本地工作区尚未就绪。");
      const waitsForApproval =
        request.method === "POST" &&
        (url.pathname === workerRoutes.toolsScripts ||
          url.pathname === workerRoutes.toolsPlugins);
      return mounted.requests.run(
        request,
        response,
        (signal) => handle(request, response, signal),
        url.pathname === workerRoutes.toolsScripts
          ? scriptToolTimeoutMs
          : waitsForApproval
            ? 6 * 60_000
            : 35_000,
      );
    };
    void dispatch().catch((error: unknown) => {
      const failure =
        error instanceof AppError
          ? error
          : error instanceof ZodError
            ? new AppError("invalid_input", "命令格式无效。")
            : new AppError("internal", "后台处理失败，请保留输入后重试。");
      if (response.writableEnded || response.destroyed) return;
      if (!response.headersSent)
        reply(
          response,
          failure.code === "unauthorized"
            ? 401
            : failure.code === "internal"
              ? 500
              : 400,
          { error: { code: failure.code, message: failure.message } },
        );
      else response.destroy();
    });
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;

  return server;
}
