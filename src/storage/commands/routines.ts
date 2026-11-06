import type { RoutineCommand } from "../../shared/routines.js";
import {
  handle,
  type CommandHandlers,
  type CommandContext,
} from "./context.js";

function routine<T extends RoutineCommand["type"]>(type: T) {
  return handle(
    type,
    (command, ctx: Pick<CommandContext, "routines" | "enqueueRoutine">) =>
      ctx.routines.execute(command, ctx.enqueueRoutine, Date.now()),
  );
}

export const routineHandlers = {
  "routine.save": routine("routine.save"),
  "routine.state": routine("routine.state"),
  "routine.test": routine("routine.test"),
  "routine.key": routine("routine.key"),
} satisfies Pick<
  CommandHandlers,
  "routine.save" | "routine.state" | "routine.test" | "routine.key"
>;
