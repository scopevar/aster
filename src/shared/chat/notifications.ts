import { z } from "zod";

const id = z.uuid();
export const notificationInputSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
export const notificationRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    text: notificationInputSchema.shape.text,
  })
  .strict();
export const notificationResultSchema = z
  .object({
    status: z.literal("sent"),
    messageId: id,
    conversationId: id,
  })
  .strict();
export type NotificationInput = z.infer<typeof notificationInputSchema>;
export type NotificationResult = z.infer<typeof notificationResultSchema>;
