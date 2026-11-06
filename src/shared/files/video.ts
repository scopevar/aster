import { z } from "zod";
const timeMs = z.number().int().min(0).max(86400000);
export const videoOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("video.info") }).strict(),
  z.object({ action: z.literal("video.frame"), timeMs }).strict(),
]);
export type VideoOperation = z.infer<typeof videoOperationSchema>;
export const videoResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("video.info"),
      width: z.number().int().positive().max(8192),
      height: z.number().int().positive().max(8192),
      durationMs: timeMs.nullable(),
      hasAudio: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("video.frame"),
      requestedMs: timeMs,
      durationMs: timeMs.nullable(),
      selection: z.literal("last-frame-at-or-before"),
      width: z.number().int().positive().max(1600),
      height: z.number().int().positive().max(1600),
      mime: z.literal("image/jpeg"),
      image: z.string().max(4 * 1024 * 1024),
    })
    .strict(),
]);
export type VideoResult = z.infer<typeof videoResultSchema>;
