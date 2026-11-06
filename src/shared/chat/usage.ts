import { z } from "zod";

export const usageWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  usedPercent: z.number().nonnegative().nullable(),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});
export const usageSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  checkedAt: z.number().int(),
  windows: z.array(usageWindowSchema).max(128),
  detail: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;
