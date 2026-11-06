import { z } from "zod";
import { idSchema } from "../core.js";
import { runStatusSchema } from "./runs.js";
import { quoteSchema } from "./conversations.js";
import { computerToolSchema } from "../tools/tool-calls.js";
import { pluginCallSchema } from "../tools/plugins.js";
import { questionSchema } from "./questions.js";
import { documentCallSchema } from "../files/documents.js";
import { routineReceiptSchema } from "../routines.js";
import { templateReceiptSchema } from "../templates/template-tools.js";
import {
  attachmentSchema,
  maxAttachmentsPerMessage,
} from "../files/attachments.js";
import { skillSummarySchema } from "../tools/skills.js";

export const reactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int(),
  mine: z.boolean(),
});
export const toolSchema = z.object({
  kind: z.literal("command"),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "completed", "failed", "declined", "unknown"]),
  output: z.string(),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
});
export type ToolExecution = z.infer<typeof toolSchema>;
export const messageSchema = z.object({
  syncStatus: z.enum(["local", "pending", "synced"]).default("local"),
  sendStatus: z.enum(["pending", "sent"]).optional(),
  id: idSchema,
  botId: idSchema,
  conversationId: idSchema,
  sequence: z.number().int(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.number(),
  runId: idSchema,
  groupOrdinal: z.number().int().nonnegative().nullable().default(null),
  runStatus: runStatusSchema,
  runError: z.string().nullable(),
  reactions: z.array(reactionSchema),
  replyTo: quoteSchema.nullable(),
  tool: toolSchema.nullable(),
  computerTool: computerToolSchema.nullable(),
  pluginCall: pluginCallSchema.nullable().default(null),
  question: questionSchema.nullable(),
  document: documentCallSchema.nullable(),
  routine: routineReceiptSchema.nullable(),
  template: templateReceiptSchema.nullable().default(null),
  attachments: z.array(attachmentSchema).max(maxAttachmentsPerMessage),
  skills: z.array(skillSummarySchema).max(4),
});
export type Message = z.infer<typeof messageSchema>;
