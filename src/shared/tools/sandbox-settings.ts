import { z } from "zod";
import { scriptHostnameSchema } from "./scripts.js";

const ip = z.union([z.ipv4(), z.ipv6()]);
const endpoint = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      const url = new URL(`tcp://${value}`);
      return (
        !url.username &&
        !url.password &&
        !url.pathname &&
        !url.search &&
        !url.hash &&
        ip.safeParse(url.hostname.replace(/^\[|\]$/g, "")).success &&
        /^\d+$/.test(url.port) &&
        Number(url.port) > 0 &&
        Number(url.port) <= 65535
      );
    } catch {
      return false;
    }
  }, "请输入 IP:端口，IPv6 地址需使用方括号。");

export const sandboxNetworkConfigurationSchema = z
  .object({
    dns: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("auto") }).strict(),
      z.object({ mode: z.literal("system") }).strict(),
      z
        .object({
          mode: z.literal("custom"),
          servers: z.array(endpoint).min(1).max(3),
        })
        .strict(),
    ]),
    proxy: z
      .object({ protocol: z.enum(["http", "socks5"]), address: endpoint })
      .strict()
      .nullable(),
  })
  .strict();
export type SandboxNetworkConfiguration = z.infer<
  typeof sandboxNetworkConfigurationSchema
>;
export function defaultSandboxNetworkConfiguration(): SandboxNetworkConfiguration {
  return { dns: { mode: "auto" }, proxy: null };
}

const check = z
  .object({
    state: z.enum(["pending", "passed", "failed"]),
    detail: z.string().max(1000),
  })
  .strict();
export const sandboxNetworkTestSchema = z
  .object({
    id: z.uuid(),
    hostname: scriptHostnameSchema,
    state: z.enum(["running", "passed", "failed", "cancelled"]),
    detail: z.string().max(1000),
    systemAddresses: z.array(ip).max(16),
    dns: check,
    https: check,
  })
  .strict();
export type SandboxNetworkTest = z.infer<typeof sandboxNetworkTestSchema>;
export const sandboxSettingsStatusSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    configuration: sandboxNetworkConfigurationSchema,
    resources: z
      .object({
        state: z.enum(["unprepared", "preparing", "ready"]),
        detail: z.string().max(1000),
      })
      .strict(),
    test: sandboxNetworkTestSchema.nullable(),
    notice: z.string().max(1000),
  })
  .strict();
export type SandboxSettingsStatus = z.infer<typeof sandboxSettingsStatusSchema>;
export const sandboxSettingsRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("prepare") }).strict(),
  z
    .object({
      action: z.literal("save"),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      configuration: sandboxNetworkConfigurationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("test"),
      id: z.uuid(),
      hostname: scriptHostnameSchema,
      configuration: sandboxNetworkConfigurationSchema,
    })
    .strict(),
  z.object({ action: z.literal("cancel"), id: z.uuid() }).strict(),
]);
export type SandboxSettingsRequest = z.infer<
  typeof sandboxSettingsRequestSchema
>;
