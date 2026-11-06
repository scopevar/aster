import { z } from "zod";

const id = z.uuid();
export const routineScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(1).max(120),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("at"),
      at: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delay"),
      seconds: z.number().int().min(1).max(2_592_000),
    })
    .strict(),
  z.object({ kind: z.literal("webhook") }).strict(),
]);
export const routineSchema = z.object({
  id,
  botId: id,
  name: z.string(),
  prompt: z.string(),
  schedule: routineScheduleSchema,
  state: z.enum(["active", "paused", "deleted"]),
  revision: z.number().int().nonnegative(),
  nextAt: z.number().nullable(),
  createdAt: z.number(),
  hasKey: z.boolean(),
  error: z.string().nullable(),
});
export type Routine = z.infer<typeof routineSchema>;
export type RoutineSchedule = z.infer<typeof routineScheduleSchema>;
const target = { id, botId: id, revision: z.number().int().nonnegative() };
export const routineCommandSchemas = [
  z
    .object({
      type: z.literal("routine.save"),
      ...target,
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().min(1).max(16000),
      schedule: routineScheduleSchema,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("routine.state"),
      ...target,
      state: z.enum(["active", "paused", "deleted"]),
    })
    .strict(),
  z.object({ type: z.literal("routine.test"), ...target }).strict(),
  z
    .object({
      type: z.literal("routine.key"),
      ...target,
      hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .strict(),
] as const;
export const routineCommandSchema = z.discriminatedUnion(
  "type",
  routineCommandSchemas,
);
export type RoutineCommand = z.infer<typeof routineCommandSchema>;
export const routineQuerySchema = z
  .object({
    botId: id,
    routineId: id.optional(),
    before: z.number().int().positive().optional(),
  })
  .strict();
export type RoutineQuery = z.infer<typeof routineQuerySchema>;
export const routineEventSchema = z.object({
  sequence: z.number().int(),
  id,
  routineId: id,
  source: z.enum(["schedule", "manual", "webhook"]),
  createdAt: z.number(),
  scheduledAt: z.number().nullable(),
  coveredUntil: z.number().nullable(),
  definitionRevision: z.number().int(),
  name: z.string(),
  prompt: z.string(),
  runId: id.nullable(),
  conversationId: id.nullable(),
  status: z.enum([
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "unknown",
    "skipped",
  ]),
  error: z.string().nullable(),
});
export type RoutineEvent = z.infer<typeof routineEventSchema>;
export const routineViewSchema = z.object({
  routines: z.array(routineSchema),
  events: z.array(routineEventSchema),
  hasOlder: z.boolean(),
  webhookBase: z.string(),
  schedulerError: z.string().nullable(),
});
export type RoutineView = z.infer<typeof routineViewSchema>;
export const webhookInputSchema = z
  .object({
    eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    timestamp: z.number().int().positive(),
    text: z.string().max(8000),
  })
  .strict();
export type WebhookInput = z.infer<typeof webhookInputSchema>;

export const routineSummarySchema = routineSchema.omit({ prompt: true });
export const routineOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read"), id }).strict(),
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().min(1).max(16000),
      schedule: routineScheduleSchema,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id,
      revision: z.number().int().positive(),
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().min(1).max(16000),
      schedule: routineScheduleSchema,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["pause", "delete"]),
      id,
      revision: z.number().int().positive(),
    })
    .strict(),
]);
export const routineToolRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    operation: routineOperationSchema,
  })
  .strict();
export const routineReceiptSchema = z.object({
  routine: routineSummarySchema,
  action: z.enum(["create", "update", "pause", "delete"]),
});
export type RoutineReceipt = z.infer<typeof routineReceiptSchema>;
export const routineToolResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      routines: z.array(routineSummarySchema).max(64),
    })
    .strict(),
  z.object({ action: z.literal("read"), routine: routineSchema }).strict(),
  z
    .object({
      action: z.enum(["create", "update", "pause", "delete"]),
      routine: routineSummarySchema,
      messageId: id,
    })
    .strict(),
]);
export type RoutineOperation = z.infer<typeof routineOperationSchema>;
export type RoutineToolResult = z.infer<typeof routineToolResultSchema>;
