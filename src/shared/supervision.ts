import { z } from "zod";

export const supervisionStateSchema = z.enum([
  "starting",
  "running",
  "unhealthy",
  "restarting",
  "stopped",
  "failed",
]);
export const supervisionDiagnosticsSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(false),
      reason: z.enum(["not_enabled", "invalid_record", "unreadable"]),
    })
    .strict(),
  z
    .object({
      available: z.literal(true),
      state: supervisionStateSchema,
      restarts: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
      stale: z.boolean(),
    })
    .strict(),
]);
export type SupervisionDiagnostics = z.infer<
  typeof supervisionDiagnosticsSchema
>;
