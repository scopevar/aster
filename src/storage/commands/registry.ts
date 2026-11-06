import type { Command } from "../../shared/commands.js";
import type { CommandResult } from "../../shared/core.js";
import { approvalHandlers } from "./approvals.js";
import { botHandlers } from "./bots.js";
import { type CommandContext, type CommandHandlers } from "./context.js";
import { conversationHandlers } from "./conversations.js";
import { deletionHandlers } from "./deletions.js";
import { groupHandlers } from "./groups.js";
import { memoryHandlers } from "./memory.js";
import { messageHandlers } from "./messages.js";
import { questionHandlers } from "./questions.js";
import { rejectedHandlers } from "./rejected.js";
import { routineHandlers } from "./routines.js";
import { sectionHandlers } from "./sidebar.js";
import { skillHandlers } from "./skills.js";
import { templateHandlers } from "./templates.js";

export const commandHandlers = {
  ...templateHandlers,
  ...botHandlers,
  ...conversationHandlers,
  ...messageHandlers,
  ...groupHandlers,
  ...routineHandlers,
  ...memoryHandlers,
  ...skillHandlers,
  ...questionHandlers,
  ...deletionHandlers,
  ...sectionHandlers,
  ...approvalHandlers,
  ...rejectedHandlers,
} satisfies CommandHandlers;

export type EveryCommandHasHandler = [
  Exclude<Command["type"], keyof typeof commandHandlers>,
  Exclude<keyof typeof commandHandlers, Command["type"]>,
] extends [never, never]
  ? true
  : never;

/** Runs the handler for `command.type`. A missing type fails compilation of this module. */
export function runCommand(
  command: Command,
  ctx: CommandContext,
): CommandResult {
  return commandHandlers[command.type](command, ctx);
}
