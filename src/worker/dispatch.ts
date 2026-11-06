import type { Command } from "../shared/commands.js";

export type AsyncCommandKind = "avatar";

/** Commands whose worker path needs a service outside Store.execute. */
export function asyncCommandKind(
  command: Command,
): AsyncCommandKind | undefined {
  if (
    command.type === "template.import" ||
    command.type === "bot.avatar.image" ||
    (command.type === "template.save" && command.payload.avatar.image !== null)
  )
    return "avatar";
  return undefined;
}
