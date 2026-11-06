import { z } from "zod";
import { messageSchema } from "./messages.js";

const sequenceSchema = z.number().int().positive().safe();

export const messageSearchQuerySchema = z
  .object({
    version: z.literal(1),
    text: z.string().trim().min(1).max(160),
    before: sequenceSchema.optional(),
  })
  .strict();
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;

export const messageSearchResultSchema = z
  .object({
    version: z.literal(1),
    hits: z
      .array(
        z
          .object({
            messageId: z.uuid(),
            conversationId: z.uuid(),
            sequence: sequenceSchema,
            role: z.enum(["user", "assistant"]),
            createdAt: z.number(),
            excerpt: z.string().max(200),
          })
          .strict(),
      )
      .max(50),
    nextBefore: sequenceSchema.nullable(),
    scanned: z.number().int().min(0).max(500),
  })
  .strict();
export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;
export type MessageSearchHit = MessageSearchResult["hits"][number];

export const messageHistoryQuerySchema = z.discriminatedUnion("direction", [
  z
    .object({
      version: z.literal(1),
      direction: z.literal("around"),
      conversationId: z.uuid(),
      messageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      direction: z.literal("before"),
      conversationId: z.uuid(),
      sequence: sequenceSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      direction: z.literal("after"),
      conversationId: z.uuid(),
      sequence: sequenceSchema,
    })
    .strict(),
]);
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export const messageHistoryResultSchema = z
  .object({
    version: z.literal(1),
    conversationId: z.uuid(),
    messages: z.array(messageSchema).max(100),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
  })
  .strict();
export type MessageHistoryResult = z.infer<typeof messageHistoryResultSchema>;
