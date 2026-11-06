import { z } from "zod";
import { idSchema } from "../core.js";
import { groupTurnSchema } from "./conversations.js";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runSchema = z.object({
  id: idSchema,
  botId: idSchema,
  conversationId: idSchema,
  status: runStatusSchema,
  error: z.string().nullable(),
  createdAt: z.number(),
  turnId: z.string().nullable(),
  groupTurns: z.array(groupTurnSchema),
});
export type Run = z.infer<typeof runSchema>;
