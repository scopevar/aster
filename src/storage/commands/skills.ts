import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

type Context = Pick<CommandContext, "requireBot" | "skills">;

export const skillHandlers = {
  "skill.save": handle("skill.save", (command, ctx: Context) => {
    ctx.requireBot(command.botId);
    return ctx.skills.save(command);
  }),
  "skill.delete": handle("skill.delete", (command, ctx: Context) => {
    ctx.requireBot(command.botId);
    ctx.skills.remove(command);
    return {};
  }),
} satisfies Pick<CommandHandlers, "skill.save" | "skill.delete">;
