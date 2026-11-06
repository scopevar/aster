import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

type Context = Pick<CommandContext, "memory" | "memoryJobs" | "sharedMemory">;

export const memoryHandlers = {
  "memory.save": handle("memory.save", (command, ctx: Context) =>
    ctx.memory.save(command),
  ),
  "memory.forget": handle("memory.forget", (command, ctx: Context) => {
    ctx.memory.forget(command);
    return {};
  }),
  "memory.auto": handle("memory.auto", (command, ctx: Context) => {
    ctx.memory.auto(command);
    return {};
  }),
  "memory.job": handle("memory.job", (command, ctx: Context) => {
    ctx.memoryJobs.action(command);
    return {};
  }),
  "memory.shared.save": handle("memory.shared.save", (command, ctx: Context) =>
    ctx.sharedMemory.save(command),
  ),
  "memory.shared.forget": handle(
    "memory.shared.forget",
    (command, ctx: Context) => {
      ctx.sharedMemory.forget(command);
      return {};
    },
  ),
} satisfies Pick<
  CommandHandlers,
  | "memory.save"
  | "memory.forget"
  | "memory.auto"
  | "memory.job"
  | "memory.shared.save"
  | "memory.shared.forget"
>;
