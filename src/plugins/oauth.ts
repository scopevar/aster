import { createHash } from "node:crypto";
import {
  auth,
  extractWWWAuthenticateParams,
  validateAuthorizationResponseIssuer,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import type { Store } from "../storage/store.js";
import { AppError } from "../shared/core.js";
import type { PluginAuthorization } from "../shared/tools/plugins.js";
import { pluginUrl, substitute } from "./connection.js";
import type {
  OAuthCredentialStore,
  OAuthCredentials,
} from "./oauth-credentials.js";
import { oauthCallback } from "./oauth-callback.js";
import { oauthProvider } from "./oauth-provider.js";
import { oauthFetch } from "./oauth-fetch.js";

type Scope = {
  key: string;
  fingerprint: string;
  url: URL;
  check(): void;
  signal: AbortSignal;
};
type Attempt = {
  controller: AbortController;
  status: PluginAuthorization;
  done?: Promise<void>;
};
const loginRequired = () =>
  new AppError(
    "unauthorized",
    "请在插件管理中连接或重新授权此 MCP 服务的账号。",
  );

/** Account-owned authorization; only explicit management requests may initiate browser login. */
export class PluginOAuth {
  private readonly controller = new AbortController();
  private readonly attempts = new Map<string, Attempt>();
  private readonly grants = new Map<string, AbortController>();
  private readonly fingerprints = new Map<string, string>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly revocations = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly store: Pick<Store, "plugins" | "subscribe" | "views">,
    private readonly credentials: OAuthCredentialStore,
  ) {
    this.unsubscribe = store.subscribe(() => {
      for (const [key, grant] of this.grants) {
        if (grant.signal.aborted) continue;
        const [botId, id, server] = key.split("/");
        if (!botId || !id || !server) continue;
        try {
          const value = this.store.plugins.execution(botId, id);
          if (
            createHash("sha256").update(JSON.stringify(value)).digest("hex") !==
            this.fingerprints.get(key)
          )
            throw Error("Changed configuration");
        } catch {
          void this.revoke(key);
        }
      }
    });
    // Track persisted installations before a run starts, so disabling a plugin
    // immediately after restart still revokes its saved authorization.
    for (const bot of store.views.snapshot({}).bots) {
      if (bot.lifecycle !== "active") continue;
      for (const plugin of store.plugins.list([bot.id]))
        for (const server of plugin.servers) {
          if (server.transport === "stdio") continue;
          try {
            this.scope(bot.id, plugin.id, server.name);
          } catch {
            void this.revoke(`${bot.id}/${plugin.id}/${server.name}`);
          }
        }
    }
  }
  private revoke(key: string) {
    this.grants.get(key)?.abort();
    const attempt = this.attempts.get(key);
    attempt?.controller.abort();
    if (!this.revocations.has(key)) {
      const work = (async () => {
        await attempt?.done;
        await this.refreshes.get(key)?.catch(() => {});
        await this.credentials.clear(key);
      })();
      this.revocations.set(key, work);
      // The account session owns this task; status, reconnect and shutdown observe its result.
      void work.catch(() => {});
    }
    return this.revocations.get(key);
  }
  private scope(botId: string, id: string, server: string): Scope {
    const execution = this.store.plugins.execution(botId, id);
    const config = execution.content.servers[server];
    if (!config || "command" in config)
      throw new AppError(
        "invalid_input",
        "只有远程 HTTP 或 SSE MCP 支持浏览器授权。",
      );
    if (
      Object.keys(config.headers).some(
        (key) => key.toLowerCase() === "authorization",
      )
    )
      throw new AppError(
        "invalid_input",
        "此服务已配置认证请求头，请先移除该请求头再使用 OAuth。",
      );
    const url = pluginUrl(substitute(config.url, execution.variables, ""));
    const key = `${botId}/${id}/${server}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(execution))
      .digest("hex");
    let grant = this.grants.get(key);
    if (!grant || grant.signal.aborted) {
      grant = new AbortController();
      this.grants.set(key, grant);
    }
    this.fingerprints.set(key, fingerprint);
    const signal = AbortSignal.any([this.controller.signal, grant.signal]);
    return {
      key,
      fingerprint,
      url,
      signal,
      check: () => {
        signal.throwIfAborted();
        if (
          createHash("sha256")
            .update(JSON.stringify(this.store.plugins.execution(botId, id)))
            .digest("hex") !== fingerprint
        )
          throw new AppError(
            "unauthorized",
            "插件配置已改变，原 OAuth 授权不可用。",
          );
      },
    };
  }
  async status(
    botId: string,
    id: string,
    server: string,
  ): Promise<PluginAuthorization | undefined> {
    const plugin = this.store.plugins.get(botId, id);
    if (!plugin.enabled) return;
    const config = plugin.servers.find((entry) => entry.name === server);
    if (!config || config.transport === "stdio") return;
    const definition = this.store.plugins.execution(botId, id).content.servers[
      server
    ];
    if (
      definition &&
      "url" in definition &&
      Object.keys(definition.headers).some(
        (key) => key.toLowerCase() === "authorization",
      )
    )
      return;
    try {
      const scope = this.scope(botId, id, server);
      await this.revocations.get(scope.key);
      const attempt = this.attempts.get(scope.key);
      if (attempt && attempt.status.state !== "connected")
        return attempt.status;
      const value = await this.credentials.read(scope.key, scope.fingerprint);
      scope.check();
      return {
        state: value?.tokens ? "connected" : "disconnected",
        message: "",
      };
    } catch (error) {
      return {
        state: "failed",
        message: error instanceof AppError ? error.message : "授权状态不可用。",
      };
    }
  }
  async authorize(
    botId: string,
    id: string,
    server: string,
    signal: AbortSignal,
  ) {
    const scope = this.scope(botId, id, server);
    await this.revocations.get(scope.key);
    if (
      [...this.attempts.values()].filter(
        (entry) => entry.status.state === "pending",
      ).length >= 4
    )
      throw new AppError(
        "capacity",
        "同时等待的 MCP 授权过多，请先完成或取消已有授权。",
      );
    if (this.attempts.get(scope.key)?.status.state === "pending")
      throw new AppError("conflict", "此服务已有授权等待完成，请先取消。");
    // Stop an old transport before replacing the account grant.
    this.grants.get(scope.key)?.abort();
    await this.refreshes.get(scope.key)?.catch(() => {});
    await this.credentials.clear(scope.key);
    const current = this.scope(botId, id, server);
    const controller = new AbortController();
    const active = AbortSignal.any([
      current.signal,
      controller.signal,
      AbortSignal.timeout(5 * 60 * 1000),
    ]);
    const attempt: Attempt = {
      controller,
      status: { state: "pending", message: "请在浏览器中完成授权。" },
    };
    this.attempts.set(scope.key, attempt);
    const callback = await oauthCallback(active).catch(() => {
      controller.abort();
      attempt.status = {
        state: "failed",
        message: "无法创建授权回调，请重试。",
      };
      throw new AppError("unavailable", attempt.status.message);
    });
    const data: OAuthCredentials = {
      scope: current.fingerprint,
      redirectUrl: callback.url,
    };
    let authorizationUrl: URL | undefined;
    const check = () => {
      active.throwIfAborted();
      current.check();
    };
    const provider = oauthProvider(data, {
      check,
      state: callback.state,
      save: () => this.credentials.save(current.key, data, check),
      redirect: (url) => {
        pluginUrl(url.href);
        authorizationUrl = url;
      },
    });
    const fetchFn = oauthFetch(current.url, active);
    const cancelStart = () => controller.abort();
    signal.addEventListener("abort", cancelStart, { once: true });
    try {
      signal.throwIfAborted();
      const challenge = await fetchFn(current.url, { method: "GET" });
      const params = extractWWWAuthenticateParams(challenge);
      if (
        (await auth(provider, {
          serverUrl: current.url,
          fetchFn,
          ...params,
        })) !== "REDIRECT" ||
        !authorizationUrl
      )
        throw new AppError(
          "unavailable",
          "MCP 服务未提供可用的浏览器授权入口。",
        );
      check();
      const url = authorizationUrl.href;
      attempt.done = (async () => {
        try {
          const result = await callback.result;
          const discovery = await provider.discoveryState?.();
          validateAuthorizationResponseIssuer({
            iss: result.get("iss") ?? undefined,
            expectedIssuer: discovery?.authorizationServerMetadata?.issuer,
            issParameterSupported:
              discovery?.authorizationServerMetadata
                ?.authorization_response_iss_parameter_supported === true,
          });
          if (result.has("error") || !result.get("code"))
            throw new AppError("unauthorized", "授权被拒绝或未返回授权码。");
          await auth(provider, {
            serverUrl: current.url,
            fetchFn,
            authorizationCode: result.get("code") ?? "",
            ...(result.has("iss") ? { iss: result.get("iss") ?? "" } : {}),
          });
          check();
          attempt.status = { state: "connected", message: "账号已连接。" };
        } catch {
          attempt.status = {
            state: "failed",
            message: active.aborted
              ? "授权已取消或过期，请重新连接。"
              : "授权未完成，请重新连接账号。",
          };
        } finally {
          callback.close();
        }
      })();
      return url;
    } catch (error) {
      controller.abort();
      callback.close();
      attempt.status = {
        state: "failed",
        message: "无法开始授权，请检查 MCP 服务的 OAuth 配置。",
      };
      if (error instanceof AppError) throw error;
      throw new AppError("unavailable", attempt.status.message);
    } finally {
      signal.removeEventListener("abort", cancelStart);
    }
  }
  async disconnect(botId: string, id: string, server: string) {
    this.store.plugins.get(botId, id);
    const key = `${botId}/${id}/${server}`;
    await this.revoke(key);
    await this.credentials.clear(key);
    this.attempts.delete(key);
    this.grants.delete(key);
    this.fingerprints.delete(key);
    this.revocations.delete(key);
  }
  async removeBot(botId: string) {
    for (const key of this.grants.keys())
      if (key.startsWith(`${botId}/`)) {
        await this.revoke(key);
        this.attempts.delete(key);
        this.grants.delete(key);
        this.fingerprints.delete(key);
        this.revocations.delete(key);
      }
    await this.credentials.clearBot(botId);
  }
  async transport(
    botId: string,
    id: string,
    server: string,
    signal?: AbortSignal,
  ) {
    const execution = this.store.plugins.execution(botId, id);
    const config = execution.content.servers[server];
    if (
      !config ||
      "command" in config ||
      Object.keys(config.headers).some(
        (key) => key.toLowerCase() === "authorization",
      )
    )
      return;
    const scope = this.scope(botId, id, server);
    await this.revocations.get(scope.key);
    const active = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])]);
    const check = () => {
      active.throwIfAborted();
      scope.check();
    };
    const provider: AuthProvider = {
      token: async () => {
        check();
        const data = await this.credentials.read(scope.key, scope.fingerprint);
        check();
        return data?.tokens?.access_token;
      },
      onUnauthorized: async (context) => {
        const required = () => {
          if (
            !active.aborted &&
            this.attempts.get(scope.key)?.status.state !== "pending"
          )
            this.attempts.set(scope.key, {
              controller: new AbortController(),
              status: {
                state: "failed",
                message: "账号授权已失效，请重新连接。",
              },
            });
          return loginRequired();
        };
        const old = this.refreshes.get(scope.key);
        if (old) {
          await old;
          return;
        }
        const work = (async () => {
          check();
          const data = await this.credentials.read(
            scope.key,
            scope.fingerprint,
          );
          if (!data?.tokens?.refresh_token) throw required();
          const oauth = oauthProvider(data, {
            check,
            save: () => this.credentials.save(scope.key, data, check),
            redirect: () => {
              throw loginRequired();
            },
          });
          const { resourceMetadataUrl, scope: requestedScope } =
            extractWWWAuthenticateParams(context.response);
          try {
            await auth(oauth, {
              serverUrl: scope.url,
              fetchFn: oauthFetch(scope.url, active),
              ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
              ...(requestedScope ? { scope: requestedScope } : {}),
            });
          } catch {
            throw required();
          }
        })();
        this.refreshes.set(scope.key, work);
        try {
          await work;
        } finally {
          if (this.refreshes.get(scope.key) === work)
            this.refreshes.delete(scope.key);
        }
      },
    };
    return { provider, signal: scope.signal };
  }
  async close() {
    this.controller.abort();
    this.unsubscribe();
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    const results = await Promise.allSettled([
      ...this.refreshes.values(),
      ...this.revocations.values(),
      ...[...this.attempts.values()].flatMap((entry) =>
        entry.done ? [entry.done] : [],
      ),
    ]);
    for (const result of results)
      if (result.status === "rejected")
        console.error("MCP 授权后台清理未完成，请重新检查账号连接状态。");
  }
}
