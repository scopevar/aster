import type { WorkerPath } from "../shared/protocol.js";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type ZodType } from "zod";
import type { Runtime } from "../chat/runtime.js";
import { AppError } from "../shared/core.js";
import { workerEventTiming } from "../shared/worker-events.js";
import type { Store } from "../storage/store.js";

export function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export async function readJson(
  request: IncomingMessage,
  limit = 128 * 1024,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    signal?.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > limit)
      throw new AppError("invalid_input", "请求超过大小限制。");
    chunks.push(bytes);
  }
  signal?.throwIfAborted();
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    throw new AppError("invalid_input", "请求不是有效 JSON。");
  }
}

export type HttpContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  signal: AbortSignal;
};
export type RouteContext = HttpContext & { store: Store; runtime: Runtime };

export type WorkerRoute = {
  method: "GET" | "POST" | "ANY";
  path: WorkerPath;
  match: "exact" | "prefix";
  bodyLimit: number | undefined;
  enabled: (() => boolean) | undefined;
} & (
  | { scope?: "data"; run: (ctx: RouteContext) => Promise<void> }
  | { scope: "control"; run: (ctx: HttpContext) => Promise<void> }
);

export type WakeTopic = "command" | "webhook" | "routineTool";

export function routeMatches(
  route: WorkerRoute,
  method: string | undefined,
  pathname: string,
): boolean {
  if (route.method !== "ANY" && route.method !== method) return false;
  const hit =
    route.match === "prefix"
      ? pathname.startsWith(route.path)
      : pathname === route.path;
  return hit && (route.enabled ? route.enabled() : true);
}

export function uniqueRoutes(list: readonly WorkerRoute[]) {
  const seen = new Set<string>();
  for (const route of list) {
    const key = `${route.method} ${route.match} ${route.path}`;
    if (seen.has(key)) throw new Error(`重复的后台路由：${key}`);
    seen.add(key);
  }
}

export function jsonRoute<T>(
  path: WorkerPath,
  schema: ZodType<T>,
  bodyLimit: number | undefined,
  handle: (input: T, ctx: RouteContext) => Promise<void>,
  enabled?: () => boolean,
): WorkerRoute {
  const route: WorkerRoute = {
    method: "POST",
    path,
    match: "exact",
    bodyLimit,
    enabled,
    run: async (ctx) => {
      await handle(
        schema.parse(await readJson(ctx.request, route.bodyLimit, ctx.signal)),
        ctx,
      );
    },
  };
  return route;
}

/** Device control remains available when an account could not be mounted. */
export function controlJsonRoute<T>(
  path: WorkerPath,
  schema: ZodType<T>,
  limit: number,
  handle: (input: T, ctx: HttpContext) => Promise<void>,
  enabled?: () => boolean,
): WorkerRoute {
  return {
    scope: "control",
    method: "POST",
    path,
    match: "exact",
    bodyLimit: limit,
    enabled,
    run: async (ctx) =>
      handle(schema.parse(await readJson(ctx.request, limit, ctx.signal)), ctx),
  };
}

export function manualPost<T>(
  path: WorkerPath,
  schema: ZodType<T>,
  bodyLimit: number | undefined,
  handle: (ctx: RouteContext, read: () => Promise<T>) => Promise<void>,
): WorkerRoute {
  const route: WorkerRoute = {
    method: "POST",
    path,
    match: "exact",
    bodyLimit,
    enabled: undefined,
    run: (ctx) =>
      handle(ctx, async () =>
        schema.parse(await readJson(ctx.request, route.bodyLimit, ctx.signal)),
      ),
  };
  return route;
}

export function queryRoute<T>(
  path: WorkerPath,
  schema: ZodType<T>,
  handle: (ctx: RouteContext, parse: (value: unknown) => T) => Promise<void>,
): WorkerRoute {
  return {
    method: "GET",
    path,
    match: "exact",
    bodyLimit: undefined,
    enabled: undefined,
    run: (ctx) => handle(ctx, (value) => schema.parse(value)),
  };
}

export function bareRoute(
  method: "GET" | "POST",
  path: WorkerPath,
  handle: (ctx: RouteContext) => Promise<void>,
): WorkerRoute {
  return {
    method,
    path,
    match: "exact",
    bodyLimit: undefined,
    enabled: undefined,
    run: handle,
  };
}

/**
 * 把 store 的提交通知转为 SSE。事件体只有游标；同一 tick 内的多次提交合并为一条。
 * 返回的函数结束该流，可重复调用。
 */
export function openEventStream(response: ServerResponse, store: Store) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  let queued = false;
  const send = () => {
    queued = false;
    // [Lifecycle]: 微任务可能晚于 detachSession 执行，此时 store 已关闭，必须先确认流仍然打开。
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(store.cursor())}\n\n`);
  };
  const unsubscribe = store.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(send);
  });
  const keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, workerEventTiming.keepaliveMs);
  const end = () => {
    unsubscribe();
    clearInterval(keepalive);
    if (!response.writableEnded) response.end();
  };
  response.once("close", end);
  send();
  return end;
}

/** Abort unless the command response already finished. */
export async function replyAfterAbort(
  response: ServerResponse,
  sessionSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<unknown>,
) {
  const abort = new AbortController();
  const cancel = () => {
    if (!response.writableFinished) abort.abort();
  };
  response.on("close", cancel);
  try {
    reply(
      response,
      200,
      await run(AbortSignal.any([abort.signal, sessionSignal])),
    );
  } finally {
    response.removeListener("close", cancel);
  }
}

/** Close hook for office preview: abort on close, including an already destroyed response. */
export async function whileConnected(
  response: ServerResponse,
  sessionSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const disconnected = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", disconnected);
  try {
    if (response.destroyed) controller.abort();
    await run(AbortSignal.any([controller.signal, sessionSignal]));
  } finally {
    response.removeListener("close", disconnected);
  }
}
