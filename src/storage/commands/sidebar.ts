import type { SectionCommand } from "../../shared/chat/sidebar-sections.js";
import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

function section<T extends SectionCommand["type"]>(type: T) {
  return handle(type, (command, ctx: Pick<CommandContext, "sidebar">) => {
    ctx.sidebar.execute(command);
    return {};
  });
}

export const sectionHandlers = {
  "section.create": section("section.create"),
  "section.rename": section("section.rename"),
  "section.assign": section("section.assign"),
  "section.fold": section("section.fold"),
  "section.move": section("section.move"),
  "section.delete": section("section.delete"),
} satisfies Pick<
  CommandHandlers,
  | "section.create"
  | "section.rename"
  | "section.assign"
  | "section.fold"
  | "section.move"
  | "section.delete"
>;
