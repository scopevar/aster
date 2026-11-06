import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AppError } from "../shared/core.js";

/** One single-use loopback callback, owned by an explicit user authorization attempt. */
export async function oauthCallback(signal: AbortSignal) {
  signal.throwIfAborted();
  const state = randomBytes(32).toString("hex");
  let accept: (params: URLSearchParams) => void = () => {};
  let reject: (error: Error) => void = () => {};
  let used = false;
  const result = new Promise<URLSearchParams>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void result.catch(() => {});
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const valid =
      request.method === "GET" &&
      request.headers.host === address.host &&
      !request.headers.origin &&
      url.pathname === "/oauth/callback" &&
      url.searchParams.getAll("state").length === 1 &&
      url.searchParams.get("state") === state &&
      url.searchParams.getAll("code").length <= 1 &&
      url.searchParams.getAll("iss").length <= 1 &&
      url.searchParams.getAll("error").length <= 1 &&
      (request.url?.length ?? 0) <= 16384;
    response.writeHead(valid && !used ? 200 : 400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      Connection: "close",
    });
    if (!valid || used) {
      response.end("授权回调无效或已使用。");
      return;
    }
    used = true;
    response.end("已收到授权结果，请返回 aster 查看连接状态。");
    accept(url.searchParams);
  });
  let address = new URL("http://127.0.0.1");
  const close = () => {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
    reject(new AppError("unavailable", "MCP 授权已取消或过期。"));
  };
  const abort = () => close();
  try {
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", fail);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === "string")
      throw Error("Invalid callback address");
    address = new URL(`http://127.0.0.1:${bound.port}/oauth/callback`);
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    return { url: address.href, state, result, close };
  } catch (error) {
    close();
    throw error;
  }
}
