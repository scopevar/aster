import { z } from "zod";
import { skillSchema } from "./skills.js";

const text = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const pluginVariablesSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), text)
  .refine((value) => Object.keys(value).length <= 64);
export const pluginMcpSchema = z.union([
  z
    .object({
      command: text.min(1),
      args: z.array(text).max(64).default([]),
      env: pluginVariablesSchema.default({}),
    })
    .strict(),
  z
    .object({
      url: text.min(1),
      type: z.enum(["http", "sse"]).default("http"),
      headers: z
        .record(
          z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/),
          text.refine((value) => !/[\r\n]/.test(value)),
        )
        .refine((value) => Object.keys(value).length <= 64)
        .default({}),
    })
    .strict(),
]);
export const pluginContentSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500),
    version: z.string().max(80),
    format: z.enum(["cursor", "claude", "generic"]),
    skills: z
      .array(
        z
          .object({
            name: skillSchema.shape.name,
            description: skillSchema.shape.description,
            body: skillSchema.shape.body,
          })
          .strict(),
      )
      .max(100),
    servers: z
      .record(z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), pluginMcpSchema)
      .refine((value) => Object.keys(value).length <= 16),
    variables: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
    warnings: z.array(z.string().max(500)).max(20),
    files: z
      .record(z.string(), z.string())
      .refine((value) => Object.keys(value).length <= 512),
  })
  .strict();
export const pluginPreviewSchema = pluginContentSchema
  .omit({ files: true, servers: true, skills: true })
  .extend({
    id: z.uuid(),
    botId: z.uuid(),
    epoch: z.uuid(),
    skills: z.array(z.object({ name: z.string(), description: z.string() })),
    servers: z.array(
      z.object({
        name: z.string(),
        transport: z.enum(["stdio", "http", "sse"]),
        target: z.string(),
        authorization: z
          .object({
            state: z.enum(["disconnected", "pending", "connected", "failed"]),
            message: z.string().max(1000),
          })
          .optional(),
      }),
    ),
  });
export const installedPluginSchema = pluginPreviewSchema
  .omit({ epoch: true })
  .extend({ enabled: z.boolean(), installedAt: z.number() });
export const pluginsRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), botId: z.uuid() }).strict(),
  z.object({ action: z.literal("prepare"), botId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("install"),
      botId: z.uuid(),
      id: z.uuid(),
      epoch: z.uuid(),
      variables: pluginVariablesSchema,
      enableTools: z.boolean(),
    })
    .strict(),
  z
    .object({ action: z.literal("remove"), botId: z.uuid(), id: z.uuid() })
    .strict(),
  z
    .object({
      action: z.literal("configure"),
      botId: z.uuid(),
      id: z.uuid(),
      enabled: z.boolean(),
      variables: pluginVariablesSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("decide"),
      botId: z.uuid(),
      id: z.uuid(),
      allow: z.boolean(),
    })
    .strict(),

  z
    .object({
      action: z.enum(["authorize", "disconnect"]),
      botId: z.uuid(),
      id: z.uuid(),
      server: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    })
    .strict(),
]);
export const pluginsResponseSchema = z
  .object({
    plugins: z.array(installedPluginSchema),
    preview: pluginPreviewSchema.nullable(),
    notice: z.string().max(1000),
    authorizationUrl: z.string().url().max(16384).optional(),
  })
  .strict();
export const pluginWorkerRequestSchema = z.union([
  z.discriminatedUnion("action", [
    pluginsRequestSchema.options[0],
    pluginsRequestSchema.options[2],
    pluginsRequestSchema.options[3],
    pluginsRequestSchema.options[4],
    pluginsRequestSchema.options[5],
    pluginsRequestSchema.options[6],
  ]),
  z
    .object({
      action: z.literal("prepare"),
      botId: z.uuid(),
      root: z.string().min(1).max(4096),
      epoch: z.uuid(),
    })
    .strict(),
]);
export const pluginToolRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    operation: z.discriminatedUnion("action", [
      z.object({ action: z.literal("list") }).strict(),
      z
        .object({
          action: z.literal("call"),
          pluginId: z.uuid(),
          server: z.string().max(80),
          tool: z.string().min(1).max(160),
          arguments: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ]),
  })
  .strict();
export const pluginCallSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    pluginId: z.uuid(),
    pluginName: z.string(),
    server: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    status: z.enum([
      "pending",
      "approved",
      "running",
      "completed",
      "declined",
      "cancelled",
      "failed",
      "unknown",
    ]),
    detail: z.string().max(1000),
  })
  .strict();
export type PluginContent = z.infer<typeof pluginContentSchema>;
export type PluginPreview = z.infer<typeof pluginPreviewSchema>;
export type PluginMcp = z.infer<typeof pluginMcpSchema>;
export type PluginCall = z.infer<typeof pluginCallSchema>;
export type PluginsRequest = z.infer<typeof pluginsRequestSchema>;
export type PluginWorkerRequest = z.infer<typeof pluginWorkerRequestSchema>;
export type PluginsResponse = z.infer<typeof pluginsResponseSchema>;

export type InstalledPlugin = z.infer<typeof installedPluginSchema>;
export type PluginToolRequest = z.infer<typeof pluginToolRequestSchema>;
export type PluginAuthorization = NonNullable<
  PluginPreview["servers"][number]["authorization"]
>;
