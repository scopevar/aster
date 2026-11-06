import { z } from "zod";

export const readInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          path.startsWith("/") &&
          !/[\\\u0000-\u001f:]/.test(path) &&
          !path.split("/").some((part) => part === "." || part === ".."),
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    limit: z.number().int().min(1).max(65536).default(16384),
  })
  .strict();
export type ReadInput = z.infer<typeof readInputSchema>;
export const readRequestSchema = readInputSchema.extend({
  callId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9_:-]+$/),
});
const entry = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory", "blocked"]),
  description: z.string().optional(),
});
const file = {
  path: z.string(),
  size: z.number().int().nonnegative(),
  hash: z.string(),
};
export const readResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("directory"),
    path: z.string(),
    entries: z.array(entry).max(100),
    nextOffset: z.number().nullable(),
  }),
  z.object({
    type: z.literal("text"),
    path: z.string(),
    size: z.number().optional(),
    hash: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    text: z.string().max(65536),
    nextOffset: z.number().nullable(),
  }),
  z.object({
    type: z.literal("image"),
    ...file,
    mimeType: z.literal("image/png"),
    data: z.string().max(4 * 1024 * 1024),
  }),
  z.object({
    type: z.literal("file"),
    ...file,
    shellPath: z.string(),
    detail: z.string(),
  }),
]);
export type ReadResult = z.infer<typeof readResultSchema>;
export const artifactRequestSchema = z
  .object({
    messageId: z.string().min(1).max(160),
    paths: z.array(z.string().min(1).max(4096)).max(8),
  })
  .strict();
