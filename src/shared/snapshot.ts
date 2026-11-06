import { z } from "zod";
import { usageSchema } from "./chat/usage.js";
import { sidebarStateSchema } from "./chat/sidebar-sections.js";
import { deletionSchema } from "./deletions.js";
import { botSchema } from "./chat/bots.js";
import { skillSummarySchema } from "./tools/skills.js";
import { conversationSchema } from "./chat/conversations.js";
import { emojiSchema } from "./emoji.js";
import { messageSchema } from "./chat/messages.js";
import { runSchema } from "./chat/runs.js";
import { storeCursorSchema } from "./worker-events.js";
import { idSchema } from "./core.js";

export const capabilitySchema = z.object({
  usage: usageSchema.optional(),
  agent: z.enum(["unchecked", "ready", "unavailable"]),
  detail: z.string(),
  accountType: z.string().nullable(),
});
export const snapshotSchema = z.object({
  sidebar: sidebarStateSchema,
  deletions: z.array(deletionSchema),
  deletedClientKeys: z.array(
    z
      .string()
      .regex(
        /^(?:bot-copy|routine-editor|skill-editor|computer-command|memory-editor|question-draft|question-answer|tool-approval):[a-f0-9-]{36}(?::(?:bot|[a-f0-9-]{36}))?$/,
      ),
  ),
  revision: z.number().int(),
  bots: z.array(botSchema),
  skills: z.array(skillSummarySchema),
  conversations: z.array(conversationSchema),
  recentEmojis: z.array(emojiSchema).max(24),
  messages: z.array(messageSchema),
  runs: z.array(runSchema),
  hasOlder: z.boolean(),
  capabilities: capabilitySchema,
  epoch: z.uuid(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
/** 带游标的读取结果：数据未变化时只回 cursor，后台不重算任何会话与消息。 */
export const snapshotUpdateSchema = z.discriminatedUnion("changed", [
  z.object({ changed: z.literal(false), cursor: storeCursorSchema }).strict(),
  z.object({ changed: z.literal(true), snapshot: snapshotSchema }).strict(),
]);
export type SnapshotUpdate = z.infer<typeof snapshotUpdateSchema>;
export const querySchema = z
  .object({
    conversationId: idSchema.optional(),
    before: z.number().int().positive().optional(),
    /** 调用方已持有的游标；与后台一致时返回 changed:false，不重算快照。 */
    since: storeCursorSchema.optional(),
  })
  .strict();
export type Query = z.infer<typeof querySchema>;
