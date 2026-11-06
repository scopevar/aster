import { z } from "zod";
import { attachmentSchema } from "../files/attachments.js";

const page = {
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(20).default(20),
};
export const historyRequestSchema = z
  .object({
    operation: z.discriminatedUnion("action", [
      z.object({ action: z.literal("list"), ...page }).strict(),
      z
        .object({
          action: z.literal("search"),
          query: z.string().trim().min(1).max(200),
          ...page,
        })
        .strict(),
      z
        .object({
          action: z.literal("read"),
          id: z.uuid(),
          offset: z.number().int().nonnegative().default(0),
        })
        .strict(),
    ]),
  })
  .strict();
export type HistoryOperation = z.infer<
  typeof historyRequestSchema
>["operation"];
const summarySchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int().positive(),
    role: z.enum(["user", "assistant"]),
    botId: z.uuid(),
    createdAt: z.number().int(),
    runStatus: z.string().max(32),
    preview: z.string().max(240),
  })
  .strict();
export const historyResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum(["list", "search"]),
      messages: z.array(summarySchema).max(20),
      nextBefore: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      message: summarySchema,
      text: z.string().max(16384),
      offset: z.number().int().nonnegative(),
      nextOffset: z.number().int().positive().nullable(),
      totalCharacters: z.number().int().nonnegative(),
      attachments: z.array(attachmentSchema).max(8),
    })
    .strict(),
]);
