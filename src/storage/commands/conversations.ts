import { handle, type CommandHandlers } from "./context.js";
export const conversationHandlers = {
  "conversation.create": handle("conversation.create", (command, ctx) =>
    ctx.conversations.create(command, ctx),
  ),
  "conversation.update": handle("conversation.update", (command, ctx) =>
    ctx.conversations.update(command, ctx),
  ),
  "conversation.read": handle("conversation.read", (command, ctx) =>
    ctx.conversations.markRead(command, ctx),
  ),
  "conversation.unread": handle("conversation.unread", (command, ctx) =>
    ctx.conversations.markUnread(command, ctx),
  ),
  "draft.save": handle("draft.save", (command, ctx) =>
    ctx.conversations.saveDraft(command, ctx),
  ),
  "reply.save": handle("reply.save", (command, ctx) =>
    ctx.conversations.saveReply(command, ctx),
  ),
  "skills.select": handle("skills.select", (command, ctx) =>
    ctx.conversations.selectSkills(command, ctx),
  ),
  "attachment.remove": handle("attachment.remove", (command, ctx) =>
    ctx.conversations.removeAttachment(command, ctx),
  ),
  "directory.attach": handle("directory.attach", (command, ctx) =>
    ctx.conversations.grantDirectory(command, ctx),
  ),
  "directory.revoke": handle("directory.revoke", (command, ctx) =>
    ctx.conversations.revokeDirectory(command, ctx),
  ),
} satisfies Pick<
  CommandHandlers,
  | "conversation.create"
  | "conversation.update"
  | "conversation.read"
  | "conversation.unread"
  | "draft.save"
  | "reply.save"
  | "skills.select"
  | "attachment.remove"
  | "directory.attach"
  | "directory.revoke"
>;
