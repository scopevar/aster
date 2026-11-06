import { z } from "zod";
import { idSchema } from "./core.js";
import { routineCommandSchemas } from "./routines.js";
import { templateCommandSchemas } from "./templates/templates.js";
import { sectionCommandSchemas } from "./chat/sidebar-sections.js";
import { deletionCommandSchemas } from "./deletions.js";
import { questionAnswerSchema } from "./chat/questions.js";
import { toolDecisionSchema } from "./tools/tool-calls.js";
import {
  memorySaveSchema,
  memoryForgetSchema,
  memoryAutoSchema,
  memoryJobActionSchema,
  sharedMemorySaveSchema,
  sharedMemoryForgetSchema,
} from "./memory.js";
import {
  skillSaveSchema,
  skillDeleteSchema,
  skillReferencesSchema,
} from "./tools/skills.js";
import { avatarShapes, avatarColors, avatarBase64 } from "./avatar.js";
import { botSchema } from "./chat/bots.js";
import { maxAttachmentsPerMessage } from "./files/attachments.js";
import { emojiSchema } from "./emoji.js";

export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("bot.copy"),
      botId: idSchema,
      name: z.string().trim().min(1).max(80),
      includeSkills: z.boolean(),
      includeRoutines: z.boolean(),
    })
    .strict(),
  ...routineCommandSchemas,
  ...templateCommandSchemas,
  ...sectionCommandSchemas,
  ...deletionCommandSchemas,
  questionAnswerSchema,
  toolDecisionSchema,
  memorySaveSchema,
  memoryForgetSchema,
  memoryAutoSchema,
  memoryJobActionSchema,
  sharedMemorySaveSchema,
  sharedMemoryForgetSchema,
  skillSaveSchema,
  skillDeleteSchema,
  z.object({
    type: z.literal("skills.select"),
    conversationId: idSchema,
    references: skillReferencesSchema,
    text: z.string().max(32000),
  }),
  z.object({
    type: z.literal("bot.avatar.character"),
    botId: idSchema,
    revision: z.number().int().nonnegative(),
    shape: avatarShapes,
    color: avatarColors,
  }),
  z.object({
    type: z.literal("bot.avatar.image"),
    botId: idSchema,
    revision: z.number().int().nonnegative(),
    data: avatarBase64,
  }),
  z.object({
    type: z.literal("group.prepare"),
    memberIds: z.array(idSchema).min(1).max(8),
  }),
  z.object({
    type: z.literal("group.recipients"),
    conversationId: idSchema,
    recipientIds: z.array(idSchema).max(8),
    text: z.string().max(32000).optional(),
  }),
  z.object({
    type: z.literal("group.start"),
    hostBotId: idSchema.nullable().optional(),
    memberIds: z.array(idSchema).min(1).max(8),
    text: z.string().trim().max(32000),
    conversationId: idSchema.optional(),
    attachmentIds: z.array(idSchema).max(8).optional(),
    skills: skillReferencesSchema.optional(),
  }),
  z.object({
    type: z.literal("group.update"),
    hostBotId: idSchema.nullable().optional(),
    conversationId: idSchema,
    revision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000),
    memberIds: z.array(idSchema).min(1).max(8),
  }),
  z.object({
    type: z.literal("attachment.remove"),
    id: idSchema,
    conversationId: idSchema,
  }),
  z
    .object({
      type: z.literal("directory.attach"),
      conversationId: idSchema,
      root: z.string().min(1).max(32768),
    })
    .strict(),
  z
    .object({
      type: z.literal("directory.revoke"),
      conversationId: idSchema,
      id: idSchema,
    })
    .strict(),
  z.object({
    type: z.literal("conversation.read"),
    conversationId: idSchema,
    through: z.number().int().nonnegative(),
    readVersion: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("conversation.unread"),
    conversationId: idSchema,
  }),
  z.object({
    type: z.literal("bot.preferences"),
    botId: idSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000),
    tags: z.string().trim().max(240),
    language: botSchema.shape.language,
  }),
  z.object({
    type: z.literal("bot.create"),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000),
  }),
  z.object({
    type: z.literal("bot.update"),
    botId: idSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000),
  }),
  z.object({
    type: z.literal("conversation.create"),
    botId: idSchema,
  }),
  z.object({
    type: z.literal("conversation.update"),
    conversationId: idSchema,
    hidden: z.boolean(),
    pinned: z.boolean(),
  }),
  z.object({
    type: z.literal("draft.save"),
    conversationId: idSchema,
    text: z.string().max(32000),
  }),
  z.object({
    type: z.literal("reply.save"),
    conversationId: idSchema,
    messageId: idSchema.nullable(),
  }),
  z.object({
    type: z.literal("message.send"),
    conversationId: idSchema,
    text: z.string().trim().max(32000),
    attachmentIds: z.array(idSchema).max(maxAttachmentsPerMessage).optional(),
    recipientIds: z.array(idSchema).min(1).max(8).optional(),
    replyToId: idSchema.optional(),
    skills: skillReferencesSchema.optional(),
  }),
  z
    .object({
      type: z.literal("message.prompt"),
      conversationId: idSchema,
      text: z.string().trim().min(1).max(32000),
    })
    .strict(),
  z.object({ type: z.literal("run.cancel"), runId: idSchema }),
  z.object({ type: z.literal("run.retry"), runId: idSchema }),
  z.object({
    type: z.literal("reaction.set"),
    messageId: idSchema,
    emoji: emojiSchema,
    active: z.boolean(),
  }),
  z.object({ type: z.literal("agent.check") }),
  z.object({ type: z.literal("worker.stop") }),
]);
export type Command = z.infer<typeof commandSchema>;
export const envelopeSchema = z
  .object({
    id: idSchema,
    command: commandSchema,
    expectedEpoch: z.uuid().optional(),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
