import { z } from "zod";
import {
  attachmentInputSchema,
  attachmentSchema,
} from "../files/attachments.js";

export const scriptToolTimeoutMs = 20 * 60 * 1000;

export const scriptHostnameSchema = z
  .string()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  )
  .refine(
    (host) => !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host),
  );
export const scriptActionSchema = z
  .object({
    type: z.literal("script"),
    command: z
      .string()
      .min(1)
      .max(32768)
      .refine((s) => !s.includes("\0")),
    network: z.array(scriptHostnameSchema).max(4).default([]),
  })
  .strict();
export type ScriptAction = z.infer<typeof scriptActionSchema>;
export const scriptOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("exec"),
      ...scriptActionSchema.omit({ type: true }).shape,
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      path: z.string().max(4096).default(""),
    })
    .strict(),
  z
    .object({
      action: z.literal("export"),
      path: z.string().min(1).max(4096),
      name: attachmentInputSchema.shape.name,
    })
    .strict(),
]);
export const scriptRequestSchema = z
  .object({
    callId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_:-]+$/),
    operation: scriptOperationSchema,
  })
  .strict();
export const scriptExecutionSchema = z
  .object({
    status: z.enum(["completed", "failed", "cancelled", "declined", "expired"]),
    stdout: z.string().max(65536),
    stderr: z.string().max(65536),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    durationMs: z.number().nonnegative(),
  })
  .strict();
export type ScriptExecution = z.infer<typeof scriptExecutionSchema>;
export const scriptResultSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("exec"), result: scriptExecutionSchema })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      state: z.enum(["unprepared", "preparing", "ready", "running"]),
      detail: z.string(),
      workspace: z.literal("/workspace"),
      inputs: z.array(
        z.object({ id: z.uuid(), name: z.string(), path: z.string() }).strict(),
      ),
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      entries: z
        .array(
          z
            .object({
              name: z.string(),
              kind: z.enum(["file", "directory", "blocked"]),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({ action: z.literal("export"), attachment: attachmentSchema })
    .strict(),
]);
export type ScriptResult = z.infer<typeof scriptResultSchema>;
