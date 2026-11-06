import { randomUUID } from "node:crypto";
import { AppError } from "../shared/core.js";
import {
  pluginPreviewSchema,
  type PluginContent,
  type PluginPreview,
  type PluginWorkerRequest,
  type PluginsResponse,
} from "../shared/tools/plugins.js";
import type { Store } from "../storage/store.js";
import { capturePlugin } from "./files.js";
import { parsePlugin } from "./parser.js";
import type { PluginOAuth } from "./oauth.js";

export function previewPlugin(
  content: PluginContent,
  botId: string,
  id: string,
  epoch: string,
): PluginPreview {
  return pluginPreviewSchema.parse({
    name: content.name,
    description: content.description,
    version: content.version,
    format: content.format,
    warnings: content.warnings,
    variables: content.variables,
    botId,
    id,
    epoch,
    skills: content.skills.map(({ name, description }) => ({
      name,
      description,
    })),
    servers: Object.entries(content.servers).map(([name, server]) => ({
      name,
      transport: "command" in server ? "stdio" : server.type,
      target: "command" in server ? server.command : server.url,
    })),
  });
}

/** Drafts contain immutable bundles, belong to one account session, and expire after five minutes. */
export class PluginService {
  private drafts = new Map<
    string,
    {
      content: PluginContent;
      preview: PluginPreview;
      expiresAt: number;
    }
  >();
  private preparing = 0;
  private readonly controller = new AbortController();
  constructor(
    readonly store: Pick<
      Store,
      "cursor" | "pluginCalls" | "plugins" | "subscribe" | "views"
    >,
    readonly oauth?: PluginOAuth,
  ) {}
  close() {
    this.controller.abort();
    this.drafts.clear();
  }
  async request(
    input: PluginWorkerRequest,
    signal: AbortSignal,
  ): Promise<PluginsResponse> {
    const active = AbortSignal.any([signal, this.controller.signal]);
    active.throwIfAborted();
    this.store.plugins.list([input.botId]);
    for (const [id, draft] of this.drafts)
      if (draft.expiresAt < Date.now()) this.drafts.delete(id);
    let preview: PluginPreview | null = null;
    let notice = "";
    let authorizationUrl: string | undefined;
    switch (input.action) {
      case "authorize":
        if (!this.oauth)
          throw new AppError("unavailable", "MCP OAuth 服务未装配。");
        authorizationUrl = await this.oauth.authorize(
          input.botId,
          input.id,
          input.server,
          active,
        );
        break;
      case "disconnect":
        if (!this.oauth)
          throw new AppError("unavailable", "MCP OAuth 服务未装配。");
        await this.oauth.disconnect(input.botId, input.id, input.server);
        notice = "本机已断开此 MCP 服务的账号。";
        break;
      case "prepare": {
        const epoch = input.epoch;
        if (epoch !== this.store.cursor().epoch)
          throw new AppError("conflict", "账户已切换，请重新选择插件目录。");
        if (this.drafts.size + this.preparing >= 4)
          throw new AppError(
            "capacity",
            "待安装插件过多，请先处理已有预览或五分钟后重试。",
          );
        this.preparing++;
        let content: PluginContent;
        try {
          content = parsePlugin(await capturePlugin(input.root, active));
        } finally {
          this.preparing--;
        }
        active.throwIfAborted();
        if (epoch !== this.store.cursor().epoch)
          throw new AppError("conflict", "账户已切换，请重新预览插件。");
        this.store.plugins.list([input.botId]);
        const id = randomUUID();
        preview = previewPlugin(content, input.botId, id, epoch);
        this.drafts.set(id, {
          content,
          preview,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        break;
      }
      case "install": {
        if (input.epoch !== this.store.cursor().epoch)
          throw new AppError("conflict", "插件预览所属账户已变更。");
        const draft = this.drafts.get(input.id);
        if (!draft || draft.preview.botId !== input.botId)
          throw new AppError("not_found", "插件预览已过期，请重新选择目录。");
        if (
          input.enableTools &&
          draft.content.variables.some((key) => !input.variables[key])
        )
          throw new AppError("invalid_input", "启用 MCP 前请填写所需变量。");
        this.store.plugins.install(
          input.botId,
          input.id,
          draft.content,
          input.variables,
          input.enableTools,
        );
        notice = "插件已导入；技能可在技能目录中读取。";
        break;
      }
      case "remove":
        for (const server of this.store.plugins.get(input.botId, input.id)
          .servers)
          await this.oauth?.disconnect(input.botId, input.id, server.name);
        this.store.plugins.remove(input.botId, input.id);
        notice = "插件已卸载；你编辑过的技能已保留。";
        break;
      case "configure":
        if (!input.enabled || input.variables)
          for (const server of this.store.plugins.get(input.botId, input.id)
            .servers)
            await this.oauth?.disconnect(input.botId, input.id, server.name);
        this.store.plugins.configure(
          input.botId,
          input.id,
          input.enabled,
          input.variables,
        );
        break;
      case "decide":
        this.store.pluginCalls.decide(input.botId, input.id, input.allow);
        break;
      case "list":
        break;
    }
    const plugins = this.store.plugins.list([input.botId]);
    for (const plugin of plugins)
      for (const server of plugin.servers) {
        const authorization = await this.oauth?.status(
          input.botId,
          plugin.id,
          server.name,
        );
        if (authorization) server.authorization = authorization;
      }
    return {
      plugins,
      preview,
      notice,
      ...(authorizationUrl ? { authorizationUrl } : {}),
    };
  }
}
