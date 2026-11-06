import { z } from "zod";

export const deletionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["bot", "group"]),
  targetId: z.uuid(),
  name: z.string(),
  status: z.enum(["queued", "cleaning", "failed", "completed"]),
  error: z.string().nullable(),
  createdAt: z.number(),
  attempt: z.number().int().nonnegative(),
});
export type Deletion = z.infer<typeof deletionSchema>;
export const deletionCommandSchemas = [
  z
    .object({
      type: z.literal("entity.delete"),
      kind: z.enum(["bot", "group"]),
      targetId: z.uuid(),
      expectedName: z.string().min(1).max(160),
    })
    .strict(),
  z.object({ type: z.literal("deletion.retry"), id: z.uuid() }).strict(),
] as const;
export type DeletionCommand = z.infer<(typeof deletionCommandSchemas)[number]>;
export const deletionPlanSchema = z.object({
  conversations: z.array(z.uuid()),
  threads: z.array(
    z.object({
      botId: z.uuid(),
      ids: z.array(z.string().min(1).max(1024)),
      all: z.boolean(),
    }),
  ),
  caches: z.array(
    z.object({
      botId: z.uuid(),
      fileName: z.string().regex(/^[a-f0-9-]{36}\.(?:png|jpg|webp|txt)$/),
    }),
  ),
  botId: z.uuid().nullable(),
});
export type DeletionPlan = z.infer<typeof deletionPlanSchema>;
