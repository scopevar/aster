import { z } from "zod";
import { jevConfigSchema, jevKeySchema } from "./chat/group-host.js";

export const agentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const agentConnectionSchema = z
  .object({
    id: agentIdSchema,
    enabled: z.boolean().default(true),
    provider: agentIdSchema,
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\u0000-\u001f]*$/u),
    baseUrl: z
      .string()
      .max(2048)
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
          );
        } catch {
          return false;
        }
      }, "接口地址必须是 HTTPS 或本机 HTTP，不能包含凭据或查询参数。"),
    api: z
      .enum([
        "native",
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ])
      .default("native"),
    auth: z
      .enum(["environment", "stored", "chatgpt", "none"])
      .default("environment"),
    apiKeyEnv: z
      .string()
      .max(100)
      .regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/)
      .default(""),
    thinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .default("medium"),
    contextWindow: z.number().int().min(8192).max(2000000).default(128000),
    maxTokens: z.number().int().min(256).max(200000).default(16384),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.auth === "chatgpt" &&
      (entry.provider !== "openai" || entry.api !== "native" || entry.baseUrl)
    )
      ctx.addIssue({
        code: "custom",
        message: "ChatGPT 订阅仅支持 OpenAI 原生提供商，请清空 Base URL。",
      });
    if (entry.auth === "environment" && !entry.apiKeyEnv)
      ctx.addIssue({ code: "custom", message: "请选择后端密钥环境变量。" });
    if (entry.api !== "native" && !entry.baseUrl)
      ctx.addIssue({ code: "custom", message: "兼容接口必须填写接口地址。" });
    if (entry.auth === "none") {
      let local = false;
      try {
        local = ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(entry.baseUrl).hostname,
        );
      } catch {
        local = false;
      }
      if (
        !local ||
        !["openai-completions", "openai-responses"].includes(entry.api)
      )
        ctx.addIssue({
          code: "custom",
          message: "无认证模式仅支持本机 OpenAI 兼容接口。",
        });
    }
    if (entry.maxTokens >= entry.contextWindow)
      ctx.addIssue({ code: "custom", message: "输出上限必须小于上下文窗口。" });
  });
export const agentConnectionsConfigSchema = z
  .object({
    defaultAgent: z.union([z.literal(""), agentIdSchema]),
    connections: z.array(agentConnectionSchema).max(64),
    botConnections: z.record(z.uuid(), agentIdSchema).optional(),
    jev: jevConfigSchema.optional(),
    retainCancelledContext: z.boolean().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set(config.connections.map((entry) => entry.id));
    if (ids.size !== config.connections.length)
      ctx.addIssue({ code: "custom", message: "连接名称不能重复。" });
    if (
      config.connections.length === 0
        ? config.defaultAgent !== ""
        : !ids.has(config.defaultAgent)
    )
      ctx.addIssue({ code: "custom", message: "默认连接必须存在。" });
  });
const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(16000)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
export const agentConnectionsRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("jev.test"),
      config: jevConfigSchema,
      apiKey: jevKeySchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("assign"),
      botId: z.uuid(),
      connectionId: agentIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      revision: z.string().max(64),
      config: agentConnectionsConfigSchema,
      jevApiKey: jevKeySchema.optional(),
      credential: z
        .object({ provider: agentIdSchema, key: apiKeySchema })
        .strict()
        .optional(),
    })
    .strict()
    .refine(
      (value) =>
        !value.credential ||
        value.config.connections.some(
          (entry) =>
            entry.provider === value.credential?.provider &&
            entry.auth === "stored",
        ),
      "密钥必须属于使用应用凭证库的提供商。",
    ),
  z
    .object({
      action: z.enum(["check", "test"]),
      connection: agentConnectionSchema,
      apiKey: apiKeySchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.apiKey === undefined || value.connection.auth === "stored",
      "只有应用凭证库可提交 API Key。",
    ),
]);
export const agentConnectionsStatusSchema = z
  .object({
    revision: z.string(),
    config: agentConnectionsConfigSchema,
    path: z.string(),
    override: z.string().nullable(),
    active: z.string(),
    notice: z.string(),
    storedProviders: z.array(agentIdSchema).optional(),
    jevHasKey: z.boolean().optional(),
  })
  .strict();
export type AgentConnection = z.infer<typeof agentConnectionSchema>;
export type AgentConnectionsConfig = z.infer<
  typeof agentConnectionsConfigSchema
>;
export type AgentConnectionsRequest = z.infer<
  typeof agentConnectionsRequestSchema
>;
export type AgentConnectionsStatus = z.infer<
  typeof agentConnectionsStatusSchema
>;
