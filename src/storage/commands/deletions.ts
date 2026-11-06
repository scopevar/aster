import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

type Context = Pick<CommandContext, "deletions">;

export const deletionHandlers = {
  "entity.delete": handle("entity.delete", (command, ctx: Context) =>
    ctx.deletions.begin(command),
  ),
  "deletion.retry": handle("deletion.retry", (command, ctx: Context) => {
    ctx.deletions.retry(command.id);
    return {};
  }),
} satisfies Pick<CommandHandlers, "entity.delete" | "deletion.retry">;
