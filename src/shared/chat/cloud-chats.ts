import { z } from "zod";
import { botSchema } from "./bots.js";
import { groupSchema } from "./conversations.js";
import { messageSchema } from "./messages.js";
import { runSchema } from "./runs.js";
import { sidebarStateSchema } from "./sidebar-sections.js";

export const cloudSidebarId = "00000000-0000-4000-8000-000000000001";
export const cloudConversationSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    hidden: z.boolean(),
    pinned: z.boolean(),
    createdAt: z.number().int(),
    readMessageId: z.uuid().nullable(),
    markedUnread: z.boolean(),
    readVersion: z.number().int().nonnegative(),
    group: groupSchema.omit({ draftRecipientIds: true }).strict().nullable(),
  })
  .strict();
export const cloudRunSchema = runSchema.omit({ turnId: true }).strict();
// Execution paths and credentials are not part of the transferable history.
export const cloudMessageSchema = messageSchema
  .omit({ syncStatus: true, sendStatus: true })
  .strict();
export const cloudPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), value: botSchema.strict() }).strict(),
  z
    .object({ kind: z.literal("conversation"), value: cloudConversationSchema })
    .strict(),
  z.object({ kind: z.literal("run"), value: cloudRunSchema }).strict(),
  z.object({ kind: z.literal("message"), value: cloudMessageSchema }).strict(),
  z
    .object({
      kind: z.literal("sidebar"),
      value: sidebarStateSchema
        .extend({ id: z.literal(cloudSidebarId) })
        .strict(),
    })
    .strict(),
]);
