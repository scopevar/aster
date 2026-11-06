import { z } from "zod";
import { idSchema } from "../core.js";
import { skillSummarySchema } from "../tools/skills.js";
import {
  attachmentSchema,
  maxAttachmentsPerMessage,
} from "../files/attachments.js";

export const quoteSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type Quote = z.infer<typeof quoteSchema>;
export const groupSchema = z.object({
  hostBotId: idSchema.nullable().optional(),
  name: z.string(),
  description: z.string(),
  revision: z.number().int().nonnegative(),
  memberIds: z.array(idSchema).max(8),
  draft: z.boolean(),
  draftRecipientIds: z.array(idSchema).max(8),
});
export type Group = z.infer<typeof groupSchema>;
export const groupTurnSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  botId: idSchema,
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "unknown",
  ]),
  error: z.string().nullable(),
});
export type GroupTurn = z.infer<typeof groupTurnSchema>;
export const conversationSchema = z.object({
  deletionPending: z.boolean(),
  id: idSchema,
  botId: idSchema,
  hidden: z.boolean(),
  pinned: z.boolean(),
  createdAt: z.number(),
  threadId: z.string().nullable(),
  draft: z.string(),
  draftSkills: z.array(skillSummarySchema).max(4),
  replyTo: quoteSchema.nullable(),
  preview: z.string(),
  activityAt: z.number(),
  lastReadSequence: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  markedUnread: z.boolean(),
  readVersion: z.number().int().nonnegative(),
  activityStatus: z.enum(["queued", "running", "cancelling"]).nullable(),
  draftAttachments: z.array(attachmentSchema).max(maxAttachmentsPerMessage),
  directoryGrants: z
    .array(
      z.object({ id: idSchema, root: z.string().min(1).max(32768) }).strict(),
    )
    .max(8),
  group: groupSchema.nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
