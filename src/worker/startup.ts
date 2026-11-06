import { z } from "zod";

export const workerStartupSchema = z
  .object({
    kind: z.literal("worker-startup"),
    state: z.enum(["ready", "contended", "failed"]),
    message: z.string().max(1000),
  })
  .strict();
