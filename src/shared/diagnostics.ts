import { z } from "zod";
import { supervisionDiagnosticsSchema } from "./supervision.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const processDiagnosticsSchema = z
  .object({
    uptimeSeconds: count,
    rssBytes: count,
    heapUsedBytes: count,
    heapTotalBytes: count,
    externalBytes: count,
    cpuUserMicroseconds: count,
    cpuSystemMicroseconds: count,
    resources: z
      .array(
        z
          .object({ type: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), count })
          .strict(),
      )
      .max(64),
  })
  .strict();
const statusCounts = z
  .array(
    z
      .object({
        state: z.enum([
          "queued",
          "running",
          "cancelling",
          "completed",
          "failed",
          "cancelled",
          "unknown",
          "paused",
          "active",
          "deleted",
          "stopped",
          "starting",
          "stopping",
          "pending",
          "approved",
          "denied",
          "expired",
          "skipped",
          "other",
        ]),
        count,
      })
      .strict(),
  )
  .max(32);
export const storageDiagnosticsSchema = z
  .object({
    schemaVersion: count,
    databasePageBytes: count,
    records: z
      .object({
        bots: count,
        conversations: count,
        messages: count,
        attachments: count,
        skills: count,
        templates: count,
      })
      .strict(),
    runs: statusCounts,
    routines: statusCounts,
    publications: statusCounts,
    memoryJobs: statusCounts,
  })
  .strict();
export const workerDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    sampledAt: count,
    nodeVersion: z
      .string()
      .regex(/^[0-9.]+$/)
      .max(64),
    process: processDiagnosticsSchema,
    storage: storageDiagnosticsSchema,
    components: z
      .object({
        agent: z.enum(["unchecked", "ready", "unavailable"]),
        scheduler: z.enum(["ready", "failed", "unavailable"]),
        templates: z.enum(["ready", "failed", "unavailable"]),
      })
      .strict(),
  })
  .strict();
export const diagnosticsSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("desktop-main-and-worker"),
    supervision: supervisionDiagnosticsSchema.optional(),
    sampledAt: count,
    appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
    nodeVersion: z
      .string()
      .regex(/^[0-9.]+$/)
      .max(64),
    electronVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
    platform: z.enum(["win32", "linux", "darwin"]),
    architecture: z.enum(["x64", "arm64", "ia32"]),
    process: processDiagnosticsSchema,
    worker: z.discriminatedUnion("available", [
      z
        .object({ available: z.literal(true), data: workerDiagnosticsSchema })
        .strict(),
      z
        .object({
          available: z.literal(false),
          reason: z.enum(["unreachable", "invalid_response"]),
        })
        .strict(),
    ]),
  })
  .strict();
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export const diagnosticsRequestSchema = z
  .object({ requestId: z.uuid(), action: z.enum(["inspect", "save"]) })
  .strict();
export type DiagnosticsRequest = z.infer<typeof diagnosticsRequestSchema>;
export const diagnosticsResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("inspected"), report: diagnosticsSchema })
    .strict(),
  z
    .object({
      status: z.literal("saved"),
      name: z.string().min(1).max(255),
      report: diagnosticsSchema,
    })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);
export type DiagnosticsResult = z.infer<typeof diagnosticsResultSchema>;
