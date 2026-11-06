import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../shared/core.js";
import type { PluginContent, PluginMcp } from "../shared/tools/plugins.js";
import { materializePlugin } from "./files.js";

export function pluginUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("invalid_input", "MCP URL 无效。");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new AppError(
      "invalid_input",
      "MCP 仅允许 HTTPS 或本机回环 HTTP，不能在 URL 中包含凭据。",
    );
  return url;
}

export function substitute(
  value: string,
  variables: Record<string, string>,
  root: string,
) {
  return value.replace(
    /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      if (["CLAUDE_PLUGIN_ROOT", "CURSOR_PLUGIN_ROOT"].includes(name))
        return root;
      const replacement = variables[name];
      if (replacement === undefined)
        throw new AppError("invalid_input", `缺少插件变量：${name}`);
      return replacement;
    },
  );
}

/** No inherited application secrets, automatic authentication or cross-origin redirects. */
export async function connectPlugin(
  content: PluginContent,
  server: PluginMcp,
  variables: Record<string, string>,
  signal: AbortSignal,
  authorization?: { provider: AuthProvider; signal: AbortSignal },
) {
  signal = AbortSignal.any([
    signal,
    ...(authorization ? [authorization.signal] : []),
  ]);
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "aster-plugin-"));
  const client = new Client({ name: "aster-plugin-host", version: "1.0.0" });
  let transport: Transport | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener("abort", abort);
      try {
        await client.close();
      } finally {
        try {
          await transport?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    })());
  const abort = () => {
    void close().catch(() => {});
  };
  try {
    await materializePlugin(root, content.files, signal);
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    const replace = (value: string) => substitute(value, variables, root);
    if ("command" in server) {
      const env = Object.fromEntries(
        Object.entries(server.env).map(([key, value]) => [key, replace(value)]),
      );
      transport = new StdioClientTransport({
        command: replace(server.command),
        args: server.args.map(replace),
        env,
        cwd: root,
        stderr: "ignore",
        maxBufferSize: 1024 * 1024,
      });
    } else {
      const url = pluginUrl(replace(server.url));
      const headers = Object.fromEntries(
        Object.entries(server.headers).map(([key, value]) => [
          key,
          replace(value),
        ]),
      );
      const boundedFetch: typeof fetch = async (input, init) => {
        const target = pluginUrl(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (target.origin !== url.origin)
          throw new AppError("unauthorized", "MCP 拒绝跨域请求。");
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.length;
              if (bytes > 2 * 1024 * 1024)
                throw new AppError("capacity", "MCP 响应超过大小限制。");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      const options = {
        requestInit: { headers },
        fetch: boundedFetch,
        ...(authorization ? { authProvider: authorization.provider } : {}),
      };
      transport =
        server.type === "sse"
          ? new SSEClientTransport(url, options)
          : new StreamableHTTPClientTransport(url, options);
    }
    signal.throwIfAborted();
    await client.connect(transport, { signal, timeout: 15000 });
    signal.throwIfAborted();
    return { client, close };
  } catch (error) {
    await close();
    if (error instanceof AppError) throw error;
    if (
      authorization &&
      error instanceof Error &&
      error.name === "UnauthorizedError"
    )
      throw new AppError(
        "unauthorized",
        "请在插件管理中连接或重新授权此 MCP 服务的账号。",
      );
    throw new AppError(
      "unavailable",
      "插件 MCP 连接失败，请检查启动命令、地址和认证变量。",
    );
  }
}
