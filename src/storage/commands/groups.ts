import { AppError } from "../../shared/core.js";
import { handle, type CommandHandlers } from "./context.js";
import { enqueueMessage } from "./messages.js";

export const groupHandlers = {
  "group.prepare": handle("group.prepare", (command, ctx) => {
    const primary = command.memberIds[0];
    if (!primary) throw new AppError("invalid_input", "请选择群成员。");
    ctx.requireBot(primary);
    const conversationId = ctx.createConversation(primary);
    ctx.groups.create(conversationId, command.memberIds, true);
    return { conversationId };
  }),
  "group.recipients": handle("group.recipients", (command, ctx) => {
    ctx.groups.setRecipients(command.conversationId, command.recipientIds);
    if (command.text !== undefined)
      ctx.conversations.saveDraft(
        {
          type: "draft.save",
          text: command.text,
          conversationId: command.conversationId,
        },
        ctx,
      );
    return {};
  }),
  "group.start": handle("group.start", (command, ctx) => {
    const primary = command.memberIds[0];
    if (!primary) throw new AppError("invalid_input", "请选择群成员。");
    ctx.requireBot(primary);
    const conversationId =
      command.conversationId ?? ctx.createConversation(primary);
    if (command.conversationId)
      ctx.groups.activate(conversationId, command.memberIds, command.hostBotId);
    else
      ctx.groups.create(
        conversationId,
        command.memberIds,
        false,
        command.hostBotId,
      );
    return {
      ...enqueueMessage(ctx, {
        type: "message.send",
        conversationId,
        text: command.text,
        ...(command.skills ? { skills: command.skills } : {}),
        ...(command.attachmentIds
          ? { attachmentIds: command.attachmentIds }
          : {}),
      }),
      conversationId,
    };
  }),
  "group.update": handle("group.update", (command, ctx) => {
    ctx.groups.update(command.conversationId, command);
    return {};
  }),
} satisfies Pick<
  CommandHandlers,
  "group.prepare" | "group.recipients" | "group.start" | "group.update"
>;
