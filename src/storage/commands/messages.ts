import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";
import type { Command } from "../../shared/commands.js";
export function enqueueMessage(
  ctx: CommandContext,
  command: Extract<Command, { type: "message.send" }>,
  source: "composer" | "question" | "prompt" = "composer",
) {
  return ctx.messages.enqueueMessage(ctx, command, source);
}
export const messageHandlers = {
  "message.send": handle("message.send", (command, ctx) =>
    ctx.messages.send(command, ctx),
  ),
  "message.prompt": handle("message.prompt", (command, ctx) =>
    ctx.messages.prompt(command, ctx),
  ),
  "run.cancel": handle("run.cancel", (command, ctx) =>
    ctx.messages.cancel(command, ctx),
  ),
  "run.retry": handle("run.retry", (command, ctx) =>
    ctx.messages.retry(command, ctx),
  ),
  "reaction.set": handle("reaction.set", (command, ctx) =>
    ctx.messages.react(command),
  ),
} satisfies Pick<
  CommandHandlers,
  | "message.send"
  | "message.prompt"
  | "run.cancel"
  | "run.retry"
  | "reaction.set"
>;
