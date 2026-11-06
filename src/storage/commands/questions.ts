import { AppError } from "../../shared/core.js";
import { handle, type CommandHandlers } from "./context.js";
import { enqueueMessage } from "./messages.js";

export const questionHandlers = {
  "question.answer": handle("question.answer", (command, ctx) => {
    const question = ctx.questions.get(command.id);
    ctx.requireConversation(command.conversationId);
    if (!ctx.skillOwners(command.conversationId).includes(question.botId))
      throw new AppError(
        "unauthorized",
        "提问 Bot 已不在这个会话中，不能继续回答旧问题。",
      );
    const resolved = ctx.questions.resolve(command);
    if (resolved.answer === null) return { id: question.id };
    const group = ctx.groups.read(command.conversationId);
    const result = enqueueMessage(
      ctx,
      {
        type: "message.send",
        conversationId: command.conversationId,
        text: resolved.answer,
        replyToId: question.messageId,
        ...(group ? { recipientIds: [question.botId] } : {}),
      },
      "question",
    );
    if (!result.id) throw new AppError("internal", "回答运行未生成。");
    ctx.questions.attachRun(question.id, result.id);
    return result;
  }),
} satisfies Pick<CommandHandlers, "question.answer">;
