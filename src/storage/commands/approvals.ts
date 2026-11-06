import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

export const approvalHandlers = {
  "tool.decide": handle(
    "tool.decide",
    (command, ctx: Pick<CommandContext, "toolCalls">) => {
      const result = ctx.toolCalls.decide(command);
      return result;
    },
  ),
} satisfies Pick<CommandHandlers, "tool.decide">;
