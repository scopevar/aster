import { handle, type CommandHandlers } from "./context.js";
export const botHandlers = {
  "bot.create": handle("bot.create", (command, ctx) =>
    ctx.bots.create(command, ctx),
  ),
  "bot.update": handle("bot.update", (command, ctx) =>
    ctx.bots.update(command, ctx),
  ),
  "bot.preferences": handle("bot.preferences", (command, ctx) =>
    ctx.bots.preferences(command, ctx),
  ),
  "bot.copy": handle("bot.copy", (command, ctx) => ctx.bots.copy(command, ctx)),
  "bot.avatar.character": handle("bot.avatar.character", (command, ctx) =>
    ctx.bots.saveCharacter(command, ctx),
  ),
  "bot.avatar.image": handle("bot.avatar.image", (command, ctx) =>
    ctx.bots.saveImage(command, ctx),
  ),
} satisfies Pick<
  CommandHandlers,
  | "bot.create"
  | "bot.update"
  | "bot.preferences"
  | "bot.copy"
  | "bot.avatar.character"
  | "bot.avatar.image"
>;
