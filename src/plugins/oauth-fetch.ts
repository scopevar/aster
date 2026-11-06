import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FetchLike } from "@modelcontextprotocol/client";
import { publicWebAddress } from "../network/web-policy.js";
import { pinnedLookup } from "../network/pinned-lookup.js";
import { AppError } from "../shared/core.js";
import { pluginUrl } from "./connection.js";

/** OAuth discovery can cross origins; it never inherits MCP headers or follows redirects. */
export function oauthFetch(server: URL, signal: AbortSignal): FetchLike {
  return async (input, init) => {
    const url = pluginUrl(String(input));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
    const localServer = ["127.0.0.1", "localhost", "[::1]"].includes(
      server.hostname,
    );
    const addresses = await lookup(host, { all: true });
    if (
      !addresses.length ||
      (loopback
        ? !localServer
        : addresses.some((entry) => !publicWebAddress(entry.address)))
    )
      throw new AppError(
        "unauthorized",
        "OAuth 地址必须使用公网 HTTPS；本地 MCP 仅允许回环地址。 ",
      );
    const destination = addresses[0];
    if (!destination) throw new AppError("unavailable", "OAuth 地址解析失败。");
    const family = destination.family;
    if (family !== 4 && family !== 6)
      throw new AppError("unavailable", "OAuth 地址类型无效。");
    const active = AbortSignal.any([
      signal,
      AbortSignal.timeout(15000),
      ...(init?.signal ? [init.signal] : []),
    ]);
    active.throwIfAborted();
    const body = init?.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !(body instanceof URLSearchParams)
    )
      throw new AppError("invalid_input", "OAuth 请求内容无效。");
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: active,
          lookup: pinnedLookup(
            {
              address: destination.address,
              family,
              hostname: host,
              port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            },
            active,
          ),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              response.destroy(
                new AppError("capacity", "OAuth 响应超过大小限制。"),
              );
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            const status = response.statusCode ?? 502;
            if (status < 200 || status > 599) {
              reject(new AppError("unavailable", "OAuth 响应状态无效。"));
              return;
            }
            if (status >= 300 && status < 400) {
              reject(
                new AppError("unauthorized", "OAuth 请求拒绝自动重定向。"),
              );
              return;
            }
            resolve(
              new Response(
                [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
                { status, headers },
              ),
            );
          });
        },
      );
      request.on("error", reject);
      request.end(
        body === undefined || body === null ? undefined : String(body),
      );
    });
  };
}
